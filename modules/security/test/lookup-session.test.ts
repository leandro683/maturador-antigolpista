import { describe, expect, it, vi } from 'vitest';
import { lookupSession, onParticipants, type SecDeps } from '../src/handlers';
import { ReactionLimiter } from '../src/limiter';
import { scanGroupFindings } from '../src/scan';
import { context, ev, GID, HACKER, joinWebhook, setup } from './fixtures';

/** Rodízio de consulta: campanha com espiã → só as espiãs consultam foto/nome; o chip que age só remove. */
const acc = (sessionName: string, role: string, status = 'active') => ({
  id: `acc-${sessionName}`,
  sessionName,
  jid: null,
  lid: null,
  status,
  role,
});
const withAccounts = (...accounts: (ReturnType<typeof acc> & { associated?: boolean; lookup?: boolean })[]) => ({ ...context(), accounts }) as ReturnType<typeof context>;

describe('lookupSession', () => {
  it('reveza entre as espiãs conectadas e nunca devolve a conta que age', () => {
    const c = withAccounts(acc('chip-01', 'both'), acc('s1', 'spy'), acc('s2', 'spy'), acc('s3', 'spy'));
    const got = Array.from({ length: 6 }, () => lookupSession(c, 'chip-01'));
    expect(got).not.toContain('chip-01');
    expect(new Set(got)).toEqual(new Set(['s1', 's2', 's3']));
    expect(got.slice(0, 3).sort()).toEqual(['s1', 's2', 's3']); // uma de cada vez
  });

  it('espiã fora do ar sai do rodízio; todas fora do ar = ninguém consulta', () => {
    const c = withAccounts(acc('chip-01', 'both'), acc('s1', 'spy', 'banned'), acc('s2', 'spy'));
    expect([lookupSession(c, 'chip-01'), lookupSession(c, 'chip-01')]).toEqual(['s2', 's2']);
    expect(lookupSession(withAccounts(acc('chip-01', 'both'), acc('s1', 'spy', 'disconnected')), 'chip-01')).toBeNull();
  });

  it('campanha sem espiã: a conta que age consulta, como antes', () => {
    expect(lookupSession(withAccounts(acc('chip-01', 'both')), 'chip-01')).toBe('chip-01');
  });

  it('conta de fora marcada como chip de consulta entra no rodízio sem ser espiã', () => {
    const out = { ...acc('chip-fora', 'both'), associated: false, lookup: true };
    const c = withAccounts(acc('chip-01', 'both'), acc('s1', 'spy'), out);
    expect(new Set([lookupSession(c, 'chip-01'), lookupSession(c, 'chip-01')])).toEqual(new Set(['s1', 'chip-fora']));
    // conta de fora SEM a marca (só presente no grupo) não consulta
    const plain = withAccounts(acc('chip-01', 'both'), acc('s1', 'spy'), { ...acc('x', 'both'), associated: false });
    expect([lookupSession(plain, 'chip-01'), lookupSession(plain, 'chip-01')]).toEqual(['s1', 's1']);
  });
});

/** Campanha em `auto` com remoção por nome: basta o nome para virar remoção (sem montar foto). */
function arrange() {
  const t = setup({ antiHacker: { enabled: true, impersonation: 'auto', impersonationRemoveByName: true } });
  const asked: string[] = [];
  t.engine.getProfilePicture = vi.fn(async (s: string) => (asked.push(s), null));
  t.engine.getContactName = vi.fn(async (s: string) => (asked.push(s), 'Suporte Oficial'));
  t.engine.getGroup = vi.fn(async (_s: string, gid: string) => ({
    gid,
    subject: '',
    participants: [{ jid: `${HACKER}@c.us`, isAdmin: false, isSuperAdmin: false }],
  }));
  const deps: SecDeps = {
    repo: t.repo,
    engine: t.engine,
    limiter: new ReactionLimiter(),
    profileLimiter: new ReactionLimiter(30, 60_000),
  };
  return { ...t, asked, deps };
}
const join = () => ev<'group.participants'>(joinWebhook(`${HACKER}@c.us`));

describe('entrada no grupo: quem consulta x quem remove', () => {
  it('a espiã consulta foto e nome; a conta principal só remove', async () => {
    const { calls, asked, deps } = arrange();
    await onParticipants(join(), deps);
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(['spy1']));
    expect(calls.filter((c) => c.op === 'removeParticipants').map((c) => c.session)).toEqual(['chip-01']);
  });

  it('espiã fora do ar: ninguém é consultado e ninguém é removido', async () => {
    const { repo, calls, asked, deps } = arrange();
    repo.groups.get(GID)!.accounts.find((a) => a.role === 'spy')!.status = 'disconnected';
    await onParticipants(join(), deps);
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
    expect(repo.incidents).toHaveLength(0);
  });
});

describe('análise de grupo: quem consulta', () => {
  const step = { session: 'chip-01', gid: GID, payload: { messageLimit: 0, checkProfiles: true }, actionId: 'a1' } as never;

  it('consulta pela espiã, não pela conta do passo', async () => {
    const { repo, engine, asked } = arrange();
    const { result } = await scanGroupFindings({ repo, sleep: async () => {} }, engine as never, step);
    expect(new Set(asked)).toEqual(new Set(['spy1']));
    expect(result.impersonators).toBe(1);
  });

  it('espiã fora do ar: ninguém é consultado; conta como não conferido', async () => {
    const { repo, engine, asked } = arrange();
    repo.groups.get(GID)!.accounts.find((a) => a.role === 'spy')!.status = 'disconnected';
    const { result } = await scanGroupFindings({ repo, sleep: async () => {} }, engine as never, step);
    expect(asked).toEqual([]);
    expect(result).toMatchObject({ profilesChecked: 0, profilesSkipped: 1, impersonators: 0 });
  });
});
