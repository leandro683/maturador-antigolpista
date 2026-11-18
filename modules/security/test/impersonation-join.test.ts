import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { onParticipants, type SecDeps } from '../src/handlers';
import { identityOf, lidJid } from '../src/identity';
import { ReactionLimiter } from '../src/limiter';
import { photoHash } from '../src/photo';
import { ADMIN_TEAM, ev, GID, HACKER, joinWebhook, sample, setup } from './fixtures';

// arte "oficial" sintética: ruído determinístico em 90x80 (o dHash é estável e longe de uma imagem lisa)
const art = async () => {
  const raw = Buffer.alloc(90 * 80);
  let s = 12345;
  for (let i = 0; i < raw.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = s >> 16;
  }
  return new Uint8Array(
    await sharp(raw, { raw: { width: 90, height: 80, channels: 1 } })
      .png()
      .toBuffer(),
  );
};

const URL = 'https://pps.whatsapp.net/foto.jpg';
let bytes: Uint8Array;
let hash: string;
beforeAll(async () => {
  bytes = await art();
  hash = (await photoHash(bytes))!;
});

/** Campanha com impostor ligado no modo pedido e a foto de referência da arte. */
function arrange(mode: 'off' | 'review' | 'auto', extra: Record<string, unknown> = {}) {
  const t = setup({
    antiHacker: {
      enabled: true,
      impersonation: mode,
      impersonationPhotos: [{ label: 'Arte Oficial', hash }],
      ...extra,
    },
  });
  t.engine.getProfilePicture = vi.fn(async () => URL);
  t.engine.getContactName = vi.fn(async () => 'Fulano');
  const loadPhoto = vi.fn(async () => bytes);
  // getGroup padrão: quem entrou consta como membro comum (remover exige confirmação positiva)
  t.engine.getGroup = vi.fn(async (_s: string, gid: string) => ({
    gid,
    subject: '',
    participants: [HACKER, '5511999990016', '5511999990017'].map((n) => ({
      jid: `${n}@c.us`,
      isAdmin: false,
      isSuperAdmin: false,
    })),
  }));
  const deps = (over: Partial<SecDeps> = {}): SecDeps => ({
    repo: t.repo,
    engine: t.engine,
    loadPhoto,
    limiter: new ReactionLimiter(),
    profileLimiter: new ReactionLimiter(30, 60_000),
    ...over,
  });
  return { ...t, loadPhoto, deps };
}
const removals = (calls: { op: string }[]) => calls.filter((c) => c.op === 'removeParticipants');
const join = (...jids: string[]) => ev<'group.participants'>(joinWebhook(...jids));
const bucketOf = (e: { ts: number }) => Math.floor(e.ts / 60_000);

describe('anti-impostor na entrada do grupo', () => {
  it('(a) foto igual + auto: remove pelo jid, bloqueia e fecha o incidente como acted', async () => {
    const { repo, engine, calls, deps } = arrange('auto');
    const e = join(`${HACKER}@c.us`);
    const r = await onParticipants(e, deps());
    expect(removals(calls)).toEqual([{ op: 'removeParticipants', session: 'chip-01', args: [GID, [`${HACKER}@c.us`]] }]);
    expect(repo.blocked).toEqual([
      { who: identityOf(HACKER), campaignId: 'c1', name: `Impostor +${HACKER}`, toAntiSpam: true },
    ]);
    expect(repo.incidents).toHaveLength(1);
    expect(repo.incidents[0]).toMatchObject({
      kind: 'scan.impersonator',
      severity: 'critical',
      status: 'acted',
      dedupKey: `impostor:${GID}:+${HACKER}:${bucketOf(e)}`,
      details: {
        reason: 'photo',
        matched: 'Arte Oficial',
        distance: 0,
        profileName: 'Fulano',
        jid: `${HACKER}@c.us`,
      },
    });
    expect(engine.getProfilePicture).toHaveBeenCalledWith('spy1', `${HACKER}@c.us`);
    expect(r.incidents).toHaveLength(1);
  });

  it('(b) foto igual + review: só 1 incidente open, sem remoção', async () => {
    const { repo, calls, deps } = arrange('review');
    await onParticipants(join(`${HACKER}@c.us`), deps());
    expect(removals(calls)).toHaveLength(0);
    expect(repo.blocked).toHaveLength(0);
    expect(repo.incidents).toHaveLength(1);
    expect(repo.incidents[0]).toMatchObject({
      kind: 'scan.impersonator',
      severity: 'critical',
      status: 'open',
      details: { reason: 'photo', matched: 'Arte Oficial', jid: `${HACKER}@c.us` },
    });
  });

  it('(c) só o nome "Suporte" + auto: abre incidente (warning), não remove', async () => {
    const { repo, engine, calls, deps } = arrange('auto');
    engine.getContactName = vi.fn(async () => 'Suporte Oficial');
    engine.getProfilePicture = vi.fn(async () => null);
    await onParticipants(join(`${HACKER}@c.us`), deps());
    expect(removals(calls)).toHaveLength(0);
    expect(repo.incidents).toHaveLength(1);
    expect(repo.incidents[0]).toMatchObject({
      kind: 'scan.impersonator',
      severity: 'warning',
      status: 'open',
      details: { reason: 'name', matched: 'Suporte', profileName: 'Suporte Oficial' },
    });
  });

  describe('nome suspeito remove sozinho só com a caixa ligada', () => {
    const named = (mode: 'review' | 'auto', extra: Record<string, unknown> = {}) => {
      const t = arrange(mode, extra);
      t.engine.getContactName = vi.fn(async () => 'Suporte Oficial');
      t.engine.getProfilePicture = vi.fn(async () => null);
      return t;
    };

    it('(c1) nome + auto + caixa ligada: remove, bloqueia e fecha como acted (warning)', async () => {
      const { repo, calls, deps } = named('auto', { impersonationRemoveByName: true });
      await onParticipants(join(`${HACKER}@c.us`), deps());
      expect(removals(calls)).toEqual([{ op: 'removeParticipants', session: 'chip-01', args: [GID, [`${HACKER}@c.us`]] }]);
      expect(repo.blocked).toEqual([
        { who: identityOf(HACKER), campaignId: 'c1', name: `Impostor +${HACKER}`, toAntiSpam: true },
      ]);
      expect(repo.incidents).toHaveLength(1);
      expect(repo.incidents[0]).toMatchObject({
        kind: 'scan.impersonator',
        severity: 'warning',
        status: 'acted',
        details: { reason: 'name', matched: 'Suporte' },
      });
    });

    it('(c2) nome + auto + caixa desligada: só achado open, sem remoção', async () => {
      const { repo, calls, deps } = named('auto', { impersonationRemoveByName: false });
      await onParticipants(join(`${HACKER}@c.us`), deps());
      expect(removals(calls)).toHaveLength(0);
      expect(repo.blocked).toHaveLength(0);
      expect(repo.incidents).toHaveLength(1);
      expect(repo.incidents[0]).toMatchObject({ status: 'open', severity: 'warning' });
    });

    it('(c3) nome + review + caixa ligada: só achado open, sem remoção', async () => {
      const { repo, calls, deps } = named('review', { impersonationRemoveByName: true });
      await onParticipants(join(`${HACKER}@c.us`), deps());
      expect(removals(calls)).toHaveLength(0);
      expect(repo.blocked).toHaveLength(0);
      expect(repo.incidents).toHaveLength(1);
      expect(repo.incidents[0]).toMatchObject({ status: 'open' });
    });

    it('(c4) nome + caixa ligada mas pessoa admin do grupo: a trava recusa, ninguém é removido', async () => {
      const { repo, engine, calls, deps } = named('auto', { impersonationRemoveByName: true });
      engine.getGroup = vi.fn(async (_s: string, gid: string) => ({
        gid,
        subject: '',
        participants: [{ jid: `${HACKER}@c.us`, isAdmin: true, isSuperAdmin: false }],
      }));
      await onParticipants(join(`${HACKER}@c.us`), deps());
      expect(removals(calls)).toHaveLength(0);
      expect(repo.blocked).toHaveLength(0);
      expect(repo.incidents[0]!.status).toBe('failed');
      expect(repo.incidents[0]!.actions[0]).toMatchObject({ type: 'verificar-admin', ok: false, error: 'é admin do grupo' });
    });

    it('(c5) nome + caixa ligada mas pessoa na lista oficial: não é consultada nem removida', async () => {
      const { repo, engine, calls, deps } = named('auto', { impersonationRemoveByName: true });
      await onParticipants(join(`${ADMIN_TEAM}@c.us`), deps());
      expect(engine.getContactName).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
      expect(repo.incidents).toHaveLength(0);
    });
  });

  it('(d) admin do grupo nunca é removido: a trava recusa e o incidente fica failed', async () => {
    const { repo, engine, calls, deps } = arrange('auto');
    engine.getGroup = vi.fn(async (_s: string, gid: string) => ({
      gid,
      subject: '',
      participants: [{ jid: `${HACKER}@c.us`, isAdmin: true, isSuperAdmin: false }],
    }));
    await onParticipants(join(`${HACKER}@c.us`), deps());
    expect(removals(calls)).toHaveLength(0);
    expect(repo.blocked).toHaveLength(0);
    expect(repo.incidents[0]!.status).toBe('failed');
    expect(repo.incidents[0]!.actions).toEqual([
      { type: 'verificar-admin', target: `+${HACKER}`, ok: false, error: 'é admin do grupo' },
    ]);
  });

  it('(d2) super-admin também é intocável', async () => {
    const { repo, engine, calls, deps } = arrange('auto');
    engine.getGroup = vi.fn(async (_s: string, gid: string) => ({
      gid,
      subject: '',
      participants: [{ jid: `${HACKER}@c.us`, isAdmin: false, isSuperAdmin: true }],
    }));
    await onParticipants(join(`${HACKER}@c.us`), deps());
    expect(removals(calls)).toHaveLength(0);
    expect(repo.incidents[0]!.actions[0]).toMatchObject({
      type: 'verificar-admin',
      ok: false,
      error: 'é admin do grupo',
    });
  });

  it('(e) quem está na allowlist (números administrativos) não é consultado', async () => {
    const { repo, engine, calls, deps } = arrange('auto');
    await onParticipants(join(`${ADMIN_TEAM}@c.us`), deps());
    expect(engine.getProfilePicture).not.toHaveBeenCalled();
    expect(engine.getContactName).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(repo.incidents).toHaveLength(0);
  });

  it('(f0) anti-hacker desligado na campanha: nenhuma consulta, mesmo com impostor ligado', async () => {
    const { repo, engine, loadPhoto, deps } = arrange('auto', { enabled: false });
    await onParticipants(join(`${HACKER}@c.us`), deps());
    expect(engine.getProfilePicture).not.toHaveBeenCalled();
    expect(loadPhoto).not.toHaveBeenCalled();
    expect(repo.incidents).toHaveLength(0);
  });

  it('(f1) nova entrada da mesma pessoa minutos depois é avaliada de novo (dedup por minuto)', async () => {
    const { repo, deps } = arrange('review');
    const d = deps();
    const e = join(`${HACKER}@c.us`);
    await onParticipants(e, d);
    repo.incidents[0]!.status = 'acted'; // o operador já tratou o primeiro achado
    await onParticipants({ ...e, ts: e.ts + 5 * 60_000 }, d);
    expect(repo.incidents.map((i) => i.dedupKey)).toEqual([
      `impostor:${GID}:+${HACKER}:${bucketOf(e)}`,
      `impostor:${GID}:+${HACKER}:${bucketOf(e) + 5}`,
    ]);
  });

  it('(f2) nome do perfil é truncado em 100 caracteres nos detalhes', async () => {
    const { repo, engine, deps } = arrange('review');
    engine.getContactName = vi.fn(async () => `Suporte ${'x'.repeat(300)}`);
    await onParticipants(join(`${HACKER}@c.us`), deps());
    expect((repo.incidents[0]!.details as { profileName: string }).profileName).toHaveLength(100);
  });

  it('(f) modo off: nenhuma consulta', async () => {
    const { repo, engine, loadPhoto, deps } = arrange('off');
    await onParticipants(join(`${HACKER}@c.us`), deps());
    expect(engine.getProfilePicture).not.toHaveBeenCalled();
    expect(loadPhoto).not.toHaveBeenCalled();
    expect(repo.incidents).toHaveLength(0);
  });

  it('(g) evento de outra sessão (não é a conta que age): nenhuma consulta', async () => {
    const { repo, engine, deps } = arrange('auto');
    const e = join(`${HACKER}@c.us`);
    await onParticipants({ ...e, session: 'spy1' }, deps());
    expect(engine.getProfilePicture).not.toHaveBeenCalled();
    expect(repo.incidents).toHaveLength(0);
  });

  it('(h) getProfilePicture rejeita: sem incidente, o handler resolve e o próximo participante é processado', async () => {
    const { repo, engine, calls, deps } = arrange('auto');
    const other = '5511999990016';
    engine.getProfilePicture = vi.fn(async (_s: string, jid: string) => {
      if (jid.startsWith(HACKER)) throw new Error('boom');
      return URL;
    });
    const e = join(`${HACKER}@c.us`, `${other}@c.us`);
    await expect(onParticipants(e, deps())).resolves.toMatchObject({
      handled: true,
    });
    expect(repo.incidents).toHaveLength(1);
    expect(repo.incidents[0]!.dedupKey).toBe(`impostor:${GID}:+${other}:${bucketOf(e)}`);
    expect(removals(calls)).toEqual([{ op: 'removeParticipants', session: 'chip-01', args: [GID, [`${other}@c.us`]] }]);
  });

  it('(h2) falha no download da foto também não derruba nem remove', async () => {
    const { repo, calls, deps } = arrange('auto');
    const loadPhoto = vi.fn(async () => {
      throw new Error('rede');
    });
    await onParticipants(join(`${HACKER}@c.us`), deps({ loadPhoto }));
    expect(removals(calls)).toHaveLength(0);
    expect(repo.incidents).toHaveLength(0);
  });

  it('(i) participante só com LID (telefone resolvido, fora da lista): consulta e remoção usam o jid do evento', async () => {
    const { repo, engine, calls, deps } = arrange('auto');
    engine.phoneOfLid = vi.fn(async () => '5511999990011@c.us');
    engine.getGroup = vi.fn(async (_s: string, gid: string) => ({
      gid,
      subject: '',
      participants: [{ jid: '100000000000003@lid', lid: '100000000000003@lid', isAdmin: false, isSuperAdmin: false }],
    }));
    await onParticipants(join('100000000000003@lid'), deps());
    expect(engine.getProfilePicture).toHaveBeenCalledWith('spy1', '100000000000003@lid');
    expect(engine.phoneOfLid).toHaveBeenCalledWith('spy1', '100000000000003@lid'); // telefone também é consulta da espiã
    expect(removals(calls)).toEqual([{ op: 'removeParticipants', session: 'chip-01', args: [GID, ['100000000000003@lid']] }]);
    expect(repo.incidents[0]).toMatchObject({ kind: 'scan.impersonator', status: 'acted' });
  });

  it('(j) mesmo evento 2x: 1 incidente de impostor; a 2ª vez já cai no bloqueado, sem nova consulta', async () => {
    const { repo, engine, deps } = arrange('auto');
    const d = deps();
    await onParticipants(join(`${HACKER}@c.us`), d);
    await onParticipants(join(`${HACKER}@c.us`), d);
    expect(repo.incidents.map((i) => i.kind)).toEqual(['scan.impersonator', 'blocked_join']);
    expect(engine.getProfilePicture).toHaveBeenCalledTimes(1);
  });

  it('(j2) mesmo evento 2x em modo review: 1 incidente', async () => {
    const { repo, deps } = arrange('review');
    const d = deps();
    await onParticipants(join(`${HACKER}@c.us`), d);
    await onParticipants(join(`${HACKER}@c.us`), d);
    expect(repo.incidents).toHaveLength(1);
  });

  it('(k) a 31ª consulta no mesmo minuto é pulada', async () => {
    const { engine, deps } = arrange('review');
    engine.getProfilePicture = vi.fn(async () => null);
    const jids = Array.from({ length: 31 }, (_, i) => `55119000000${String(i).padStart(2, '0')}@c.us`);
    await onParticipants(join(...jids), deps());
    expect(engine.getProfilePicture).toHaveBeenCalledTimes(30);
  });

  it('(l) getGroup rejeita: não remove e registra a falha', async () => {
    const { repo, engine, calls, deps } = arrange('auto');
    engine.getGroup = vi.fn(async () => {
      throw new Error('sem conexão');
    });
    await expect(onParticipants(join(`${HACKER}@c.us`), deps())).resolves.toMatchObject({ handled: true });
    expect(removals(calls)).toHaveLength(0);
    expect(repo.blocked).toHaveLength(0);
    expect(repo.incidents[0]!.status).toBe('failed');
    expect(repo.incidents[0]!.actions[0]).toMatchObject({ ok: false });
  });

  it('bloqueado que entrou continua sendo removido e não é consultado', async () => {
    const { repo, engine, calls, deps } = arrange('auto');
    repo.preBlocked.add(identityOf(HACKER));
    await onParticipants(join(`${HACKER}@c.us`), deps());
    expect(removals(calls)).toHaveLength(1);
    expect(repo.incidents.map((i) => i.kind)).toEqual(['blocked_join']);
    expect(engine.getProfilePicture).not.toHaveBeenCalled();
  });

  it('bloqueio na entrada desligado: o impostor ainda é verificado', async () => {
    const { repo, engine, deps } = arrange('review', { removeBlockedOnJoin: false });
    repo.preBlocked.add(identityOf(HACKER));
    await onParticipants(join(`${HACKER}@c.us`), deps());
    expect(engine.getProfilePicture).toHaveBeenCalledTimes(1);
    expect(repo.incidents.map((i) => i.kind)).toEqual(['scan.impersonator']);
  });

  it('motor sem getProfilePicture: nada a fazer', async () => {
    const { repo, engine, deps } = arrange('auto');
    const bare = { ...engine, getProfilePicture: undefined };
    await onParticipants(join(`${HACKER}@c.us`), deps({ engine: bare }));
    expect(repo.incidents).toHaveLength(0);
  });

  describe('admin e allowlist nunca são removidos (positivo ou nada)', () => {
    const LID = '100000000000001@lid';
    // entrada GOWS com telefone e LID (o mapper entrega `lid` já com `@lid`)
    const joinPnLid = (pn: string, lid: string) =>
      ev<'group.participants'>(
        sample('group.v2.participants.leave', (w) => {
          const p = w.payload as Record<string, unknown>;
          p.type = 'join';
          p.participants = [{ id: lid, pn: `${pn}@c.us`, role: 'participant' }];
        }),
      );
    const groupWith = (...participants: { jid: string; lid?: string; isAdmin: boolean; isSuperAdmin: boolean }[]) =>
      vi.fn(async (_s: string, gid: string) => ({ gid, subject: '', participants }));

    it('evento com telefone+LID, getGroup só com o LID como admin: não remove (é admin do grupo)', async () => {
      const { repo, engine, calls, deps } = arrange('auto');
      engine.getGroup = groupWith({ jid: LID, lid: LID, isAdmin: true, isSuperAdmin: false });
      await onParticipants(joinPnLid(HACKER, LID), deps());
      expect(removals(calls)).toHaveLength(0);
      expect(repo.blocked).toHaveLength(0);
      expect(repo.incidents[0]!.actions[0]).toMatchObject({
        type: 'verificar-admin',
        ok: false,
        error: 'é admin do grupo',
      });
    });

    it('evento só com telefone e getGroup só com LID: não confirma, não remove, incidente failed', async () => {
      const { repo, engine, calls, deps } = arrange('auto');
      engine.getGroup = groupWith({ jid: LID, lid: LID, isAdmin: true, isSuperAdmin: false });
      await onParticipants(join(`${HACKER}@c.us`), deps());
      expect(removals(calls)).toHaveLength(0);
      expect(repo.blocked).toHaveLength(0);
      expect(repo.incidents[0]!.status).toBe('failed');
    });

    it('allowlist só com o LID: evento telefone+LID não consulta nem remove', async () => {
      const { repo, engine, calls, deps } = arrange('auto');
      repo.adminNumbers.push(identityOf(LID));
      await onParticipants(joinPnLid(HACKER, LID), deps());
      expect(engine.getProfilePicture).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
      expect(repo.incidents).toHaveLength(0);
    });

    it('allowlist só com o LID e evento só com telefone: a identidade do getGroup barra a remoção', async () => {
      const { repo, engine, calls, deps } = arrange('auto');
      repo.adminNumbers.push(identityOf(LID));
      engine.getGroup = groupWith({ jid: `${HACKER}@c.us`, lid: LID, isAdmin: false, isSuperAdmin: false });
      await onParticipants(join(`${HACKER}@c.us`), deps());
      expect(removals(calls)).toHaveLength(0);
      expect(repo.blocked).toHaveLength(0);
      expect(repo.incidents[0]!.actions[0]).toMatchObject({
        type: 'verificar-admin',
        ok: false,
        error: 'está na lista oficial',
      });
    });

    it('fora da lista do getGroup: não remove, ação verificar-admin falha e o incidente fica failed', async () => {
      const { repo, engine, calls, deps } = arrange('auto');
      engine.getGroup = groupWith();
      await onParticipants(join(`${HACKER}@c.us`), deps());
      expect(removals(calls)).toHaveLength(0);
      expect(repo.blocked).toHaveLength(0);
      expect(repo.incidents[0]!.status).toBe('failed');
      expect(repo.incidents[0]!.actions).toEqual([
        {
          type: 'verificar-admin',
          target: `+${HACKER}`,
          ok: false,
          error: 'não confirmado na lista do grupo',
        },
      ]);
    });

    it('membro comum encontrado (telefone+LID): é removido', async () => {
      const { engine, calls, deps } = arrange('auto');
      engine.getGroup = groupWith({ jid: `${HACKER}@c.us`, lid: LID, isAdmin: false, isSuperAdmin: false });
      await onParticipants(joinPnLid(HACKER, LID), deps());
      expect(removals(calls)).toHaveLength(1);
    });
    it('chip nosso com lid gravado com sufixo, entrando só com LID: nenhuma consulta de perfil, nada removido', async () => {
      const { repo, engine, calls, deps } = arrange('auto');
      repo.groups.get(GID)!.accounts[1]!.lid = LID; // como o motor entrega: lid com `@lid`
      await onParticipants(join(LID), deps());
      expect(engine.getProfilePicture).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
      expect(repo.incidents).toHaveLength(0);
    });

    it('chip do painel fora da campanha (lid com sufixo), foto da arte, auto: nenhuma consulta, remoção nem bloqueio', async () => {
      const { repo, engine, calls, deps } = arrange('auto');
      repo.agency = [identityOf('5511999990010@c.us', lidJid(LID))];
      await onParticipants(join(LID), deps());
      expect(engine.getProfilePicture).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
      expect(repo.blocked).toHaveLength(0);
      expect(repo.incidents).toHaveLength(0);
    });

    it('lista oficial só por telefone + entrada só com LID + phoneOfLid resolve o telefone: não remove', async () => {
      const { repo, engine, calls, deps } = arrange('auto');
      engine.getGroup = groupWith({ jid: LID, lid: LID, isAdmin: false, isSuperAdmin: false });
      engine.phoneOfLid = vi.fn(async () => `${ADMIN_TEAM}@c.us`);
      await onParticipants(join(LID), deps());
      expect(removals(calls)).toHaveLength(0);
      expect(repo.blocked).toHaveLength(0);
      expect(repo.incidents[0]!.actions[0]).toMatchObject({
        type: 'verificar-admin',
        ok: false,
        error: 'está na lista oficial',
      });
    });

    it('sem phoneOfLid (ausente, erro ou vazio) e só LID: não remove', async () => {
      for (const phoneOfLid of [undefined, vi.fn(async () => Promise.reject(new Error('x'))), vi.fn(async () => '')]) {
        const { repo, engine, calls, deps } = arrange('auto');
        engine.getGroup = groupWith({ jid: LID, lid: LID, isAdmin: false, isSuperAdmin: false });
        engine.phoneOfLid = phoneOfLid;
        await onParticipants(join(LID), deps());
        expect(removals(calls)).toHaveLength(0);
        expect(repo.blocked).toHaveLength(0);
        expect(repo.incidents[0]!.status).toBe('failed');
        expect(repo.incidents[0]!.actions[0]).toMatchObject({
          ok: false,
          error: 'sem telefone para conferir a lista oficial',
        });
      }
    });

    it('estranho confirmado (só LID, telefone resolvido fora da lista): removido com o jid do grupo', async () => {
      const { repo, engine, calls, deps } = arrange('auto');
      engine.getGroup = groupWith({ jid: LID, lid: LID, isAdmin: false, isSuperAdmin: false });
      engine.phoneOfLid = vi.fn(async () => `${HACKER}@c.us`);
      await onParticipants(join(LID), deps());
      expect(removals(calls)).toEqual([{ op: 'removeParticipants', session: 'chip-01', args: [GID, [LID]] }]);
      expect(repo.incidents[0]!.status).toBe('acted');
    });
  });
});
