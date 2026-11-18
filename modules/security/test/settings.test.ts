import { describe, expect, it } from 'vitest';
import { createSecHandlers, onMessage } from '../src/handlers';
import { identityOf } from '../src/identity';
import { ReactionLimiter } from '../src/limiter';
import { cachedSettings, DEFAULT_SECURITY_SETTINGS, readSecuritySettingsValue } from '../src/settings';
import { ev, GID, HACKER, messageWebhook, setup } from './fixtures';

const OTHER = '5511999990032'; // conta nossa de OUTRA campanha que está no grupo

/** evento recebido pela conta de fora (as contas da campanha estão desconectadas) */
const viaOther = () => ({ ...ev<'message.in'>(messageWebhook(HACKER, 'oi')), session: 'other1' });

function offline(s: ReturnType<typeof setup>) {
  for (const a of s.repo.groups.get(GID)!.accounts) a.status = 'disconnected';
  s.repo.extraAccounts.set(GID, [
    { id: 'acc-other', sessionName: 'other1', jid: `${OTHER}@c.us`, lid: null, status: 'active', role: 'both' },
  ]);
}

describe('interruptores globais', () => {
  it('padrões: só contas associadas = ligado; lista compartilhada em todas = desligado; leitura tolerante', () => {
    expect(DEFAULT_SECURITY_SETTINGS).toEqual({ antiSpamAssociatedOnly: true, sharedBlocklistAllCampaigns: false });
    expect(readSecuritySettingsValue(null)).toEqual(DEFAULT_SECURITY_SETTINGS);
    expect(readSecuritySettingsValue({ antiSpamAssociatedOnly: 'não', sharedBlocklistAllCampaigns: true })).toEqual({
      antiSpamAssociatedOnly: true,
      sharedBlocklistAllCampaigns: true,
    });
  });

  it('cache de 60 s: 1 leitura por minuto; erro mantém o último valor', async () => {
    let t = 0;
    let reads = 0;
    let fail = false;
    const get = cachedSettings(
      async () => {
        reads += 1;
        if (fail) throw new Error('db fora');
        return { antiSpamAssociatedOnly: reads % 2 === 1, sharedBlocklistAllCampaigns: false };
      },
      60_000,
      () => t,
    );
    expect((await get()).antiSpamAssociatedOnly).toBe(true);
    t = 59_000;
    await get();
    expect(reads).toBe(1);
    t = 61_000;
    expect((await get()).antiSpamAssociatedOnly).toBe(false);
    expect(reads).toBe(2);
    fail = true;
    t = 200_000;
    expect((await get()).antiSpamAssociatedOnly).toBe(false); // último valor bom
  });

  it('ligado (padrão): sem conta da campanha conectada, não age por conta de fora', async () => {
    const s = setup();
    offline(s);
    const r = await onMessage(viaOther(), { repo: s.repo, engine: s.engine });
    expect(r.handled).toBe(true);
    expect(s.calls).toEqual([]);
    expect(s.repo.incidents[0]!.status).toBe('failed');
    expect(s.repo.incidents[0]!.waAccountId).toBeNull();
  });

  it('desligado: conta nossa de outra campanha que está no grupo age no lugar', async () => {
    const s = setup();
    offline(s);
    s.repo.settings.antiSpamAssociatedOnly = false;
    await onMessage(viaOther(), { repo: s.repo, engine: s.engine });
    expect(s.calls.map((c) => [c.op, c.session])).toEqual([
      ['deleteMessage', 'other1'],
      ['removeParticipants', 'other1'],
    ]);
    expect(s.repo.incidents[0]!.waAccountId).toBe('acc-other');
  });

  it('desligado: conta de fora da campanha presente no grupo nunca é tratada como invasora', async () => {
    const s = setup();
    s.repo.extraAccounts.set(GID, [
      { id: 'acc-other', sessionName: 'other1', jid: `${OTHER}@c.us`, lid: null, status: 'active', role: 'both' },
    ]);
    const deps = { repo: s.repo, engine: s.engine };
    s.repo.settings.antiSpamAssociatedOnly = true;
    await onMessage(ev<'message.in'>(messageWebhook(OTHER, 'aviso', 'M1')), deps);
    expect(s.repo.incidents).toHaveLength(1); // comportamento antigo: conta de fora = estranha
    s.repo.settings.antiSpamAssociatedOnly = false;
    const r = await onMessage(ev<'message.in'>(messageWebhook(OTHER, 'aviso', 'M2')), deps);
    expect(r.note).toBe('allowlisted');
    expect(s.repo.incidents).toHaveLength(1);
    expect(s.repo.blocked.map((b) => b.who)).toEqual([identityOf(OTHER)]);
  });

  it('a fábrica dos handlers lê os interruptores 1x por minuto (não 1x por evento)', async () => {
    const s = setup();
    const h = createSecHandlers({ repo: s.repo, engine: s.engine, limiter: new ReactionLimiter(100) });
    for (let i = 0; i < 5; i++) await h['message.in'](ev<'message.in'>(messageWebhook(HACKER, 'x', `MSG${i}`)));
    expect(s.repo.settingsReads).toBe(1);
    expect(s.repo.incidents).toHaveLength(5);
  });
});
