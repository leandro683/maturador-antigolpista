import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, GroupInfo } from '@mag/wa-engine';
import { identityOf } from '../src/identity';
import { photoHash } from '../src/photo';
import { scanGroup, scanGroupFindings, scanPayloadSchema, SECURITY_SCAN_TYPE, securityScanType, type ScanEngine } from '../src/scan';
import { ADMIN_TEAM, GID, HACKER, ME, setup } from './fixtures';

const BLOCKED = '5511999990012';
const ROGUE_ADMIN = '5511999990024';
const COMUM = '5511999990013';

const info = (announce = true): GroupInfo => ({
  gid: GID,
  subject: 'Lançamento #1',
  announce,
  participants: [
    { jid: `${ME}@c.us`, isAdmin: true, isSuperAdmin: true }, // conta da campanha
    { jid: `${ADMIN_TEAM}@c.us`, isAdmin: true, isSuperAdmin: false }, // número administrativo
    { jid: `${ROGUE_ADMIN}@c.us`, isAdmin: true, isSuperAdmin: false }, // admin estranho
    { jid: `${BLOCKED}@c.us`, isAdmin: false, isSuperAdmin: false }, // bloqueado
    { jid: `${COMUM}@c.us`, isAdmin: false, isSuperAdmin: false }, // participante comum
  ],
});

const msg = (from: string, id: string, body = 'olá', fromMe = false): ChatMessage => ({
  id: `false_${GID}_${id}_${from}@c.us`,
  from: `${from}@c.us`,
  fromMe,
  body,
  hasMedia: false,
  ts: 1792115700_000,
});

function engineWith(g: GroupInfo, msgs?: ChatMessage[] | Error) {
  const calls: string[] = [];
  const e: ScanEngine = {
    getGroup: async (s, gid) => {
      calls.push(`getGroup:${s}:${gid}`);
      return g;
    },
    ...(msgs === undefined
      ? {}
      : {
          listMessages: async (s: string, gid: string, o?: { limit?: number }) => {
            calls.push(`listMessages:${s}:${gid}:${o?.limit}`);
            if (msgs instanceof Error) throw msgs;
            return msgs;
          },
        }),
  };
  return { e, calls };
}

const step = (over: Record<string, unknown> = {}) => ({
  session: 'chip-01',
  gid: GID,
  groupId: 'g1',
  payload: { messageLimit: 50 },
  index: 0,
  actionId: 'scan-1',
  accountId: 'acc-main',
  ...over,
});

describe('varredura de 1 grupo (scanGroup)', () => {
  it('cruza participantes com blacklist e admins esperados e marca mensagens de não-admin — sem agir', async () => {
    const s = setup();
    s.repo.preBlocked.add(identityOf(BLOCKED));
    const { e, calls } = engineWith(info(), [
      msg(ADMIN_TEAM, 'A1', 'aviso da equipe'),
      msg(HACKER, 'H1', 'compre aqui https://x'),
      msg(ME, 'M1', 'nossa', true),
      msg(COMUM, 'L1', 'oi'),
    ]);
    const r = await scanGroup({ repo: s.repo }, e, step());
    expect(r).toMatchObject({
      participants: 5,
      blacklisted: 1,
      unknownAdmins: 1,
      nonAdminMessages: 2,
      findings: 4,
      messages: 4,
      closed: true,
    });
    expect(r.messagesUnavailable).toBeUndefined();
    expect(calls).toEqual([`getGroup:chip-01:${GID}`, `listMessages:chip-01:${GID}:50`]);
    expect(s.calls).toEqual([]); // nada no WhatsApp
    const byKind = Object.fromEntries(s.repo.incidents.map((i) => [`${i.kind}:${i.who?.number}`, i]));
    expect(Object.keys(byKind).sort()).toEqual(
      [
        `scan.blacklisted:+${BLOCKED}`,
        `scan.non-admin-message:+${HACKER}`,
        `scan.non-admin-message:+${COMUM}`,
        `scan.unknown-admin:+${ROGUE_ADMIN}`,
      ].sort(),
    );
    for (const i of s.repo.incidents) {
      expect(i.status).toBe('open');
      expect(i.details).toMatchObject({ scanId: 'scan-1' });
      expect(i.waAccountId).toBe('acc-main');
    }
    expect(byKind[`scan.unknown-admin:+${ROGUE_ADMIN}`]!.severity).toBe('critical');
    expect(byKind[`scan.non-admin-message:+${HACKER}`]!.messageId).toBe(`false_${GID}_H1_${HACKER}@c.us`);
    expect(byKind[`scan.non-admin-message:+${HACKER}`]!.details).toMatchObject({ body: 'compre aqui https://x' });
  });

  it('nova análise não duplica achados que continuam em aberto; mensagem tratada no tempo real é pulada', async () => {
    const s = setup();
    s.repo.preBlocked.add(identityOf(BLOCKED));
    const m = msg(HACKER, 'H1');
    await s.repo.claimIncident({
      kind: 'message',
      severity: 'warning',
      status: 'acted',
      dedupKey: `msg:${GID}:${m.id}`,
      campaignId: 'c1',
      groupId: 'g1',
      waAccountId: null,
      gid: GID,
    });
    const { e } = engineWith(info(), [m]);
    const a = await scanGroup({ repo: s.repo }, e, step());
    expect(a.nonAdminMessages).toBe(0);
    const b = await scanGroup({ repo: s.repo }, e, step({ actionId: 'scan-2' }));
    expect(a.findings).toBe(2);
    expect(b.findings).toBe(0);
    expect(s.repo.incidents.filter((i) => i.kind.startsWith('scan.'))).toHaveLength(2);
  });

  it('engine sem busca de mensagens → só participantes, com aviso', async () => {
    const s = setup();
    const { e, calls } = engineWith(info());
    const r = await scanGroup({ repo: s.repo }, e, step());
    expect(r.messages).toBeNull();
    expect(r.messagesUnavailable).toMatch(/não oferece busca de mensagens/);
    expect(r.unknownAdmins).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('busca de mensagens falha (p.ex. 501 do GOWS) → passo segue, com aviso', async () => {
    const s = setup();
    const { e } = engineWith(info(), new Error('WAHA 501 em /messages: not implemented'));
    const r = await scanGroup({ repo: s.repo }, e, step());
    expect(r.messagesUnavailable).toMatch(/501/);
    expect(r.unknownAdmins).toBe(1);
  });

  it('grupo aberto ou N=0 → não lê mensagens', async () => {
    const s = setup();
    const open = engineWith(info(false), [msg(HACKER, 'H1')]);
    expect((await scanGroup({ repo: s.repo }, open.e, step())).messages).toBeNull();
    expect(open.calls).toHaveLength(1);
    const zero = engineWith(info(true), [msg(HACKER, 'H1')]);
    expect((await scanGroup({ repo: s.repo }, zero.e, step({ payload: { messageLimit: 0 } }))).messages).toBeNull();
    expect(zero.calls).toHaveLength(1);
  });

  it('contas nossas de outras campanhas nunca viram achado; grupo fora do painel → erro do passo', async () => {
    const s = setup();
    s.repo.agency = [identityOf(ROGUE_ADMIN)];
    const { e } = engineWith(info(), []);
    expect((await scanGroup({ repo: s.repo }, e, step())).unknownAdmins).toBe(0);
    await expect(scanGroup({ repo: s.repo }, e, step({ gid: '1203630000000004@g.us' }))).rejects.toThrow(/não está cadastrado/);
  });

  it('tipo security-scan: payload com padrão 50, limite 200; sem deps não roda', async () => {
    const d = securityScanType();
    expect(d.type).toBe(SECURITY_SCAN_TYPE);
    expect(scanPayloadSchema.parse({})).toEqual({ messageLimit: 50, checkProfiles: false, autoAct: false });
    expect(() => scanPayloadSchema.parse({ messageLimit: 500 })).toThrow();
    await expect(d.runStep({} as never, step() as never)).rejects.toThrow(/worker/);
  });
});

/** Imagem sintética determinística (blocos de tons por LCG); `invert` gera outra bem diferente. */
async function art(invert = false): Promise<Buffer> {
  const size = 256;
  const block = 16;
  const px = Buffer.alloc(size * size * 3);
  let s = 12345;
  const tones: number[] = [];
  for (let i = 0; i < (size / block) ** 2; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    tones.push(s % 256);
  }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const t = tones[Math.floor(y / block) * (size / block) + Math.floor(x / block)]!;
      px.fill(invert ? 255 - t : t, (y * size + x) * 3, (y * size + x) * 3 + 3);
    }
  return sharp(px, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

describe('anti-impostor: varredura confere foto e nome (checkProfiles)', () => {
  const OFFICIAL = 'http://foto/oficial.png';
  const OTHER = 'http://foto/outra.png';
  const NAMED = '5511999990011'; // foto qualquer, nome "Suporte Oficial"
  const BAD_ADMIN = ROGUE_ADMIN; // admin estranho com a foto oficial

  async function run(over: {
    pics?: Record<string, string | null | Error>;
    names?: Record<string, string | null>;
    cfg?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    deps?: { profileGapMs?: number };
    extra?: GroupInfo['participants'];
    joiners?: { who: string; joinedAt: string }[];
  }) {
    const ref = await photoHash(await art());
    const s = setup({
      antiHacker: { enabled: true, impersonation: 'review', impersonationPhotos: [{ label: 'Arte oficial', hash: ref }], ...over.cfg },
    });
    s.repo.preBlocked.add(identityOf(BLOCKED));
    const g = info();
    g.participants.push(...(over.extra ?? []));
    const asked: string[] = [];
    const { e } = engineWith(g);
    e.getProfilePicture = async (_s, jid) => {
      asked.push(jid);
      const v = over.pics?.[jid];
      if (v instanceof Error) throw v;
      return v ?? null;
    };
    e.getContactName = async (_s, jid) => over.names?.[jid] ?? null;
    const images: Record<string, Buffer> = { [OFFICIAL]: await art(), [OTHER]: await art(true) };
    const sleeps: number[] = [];
    for (const j of over.joiners ?? []) s.repo.joiners.push({ groupId: 'g1', who: identityOf(j.who), joinedAt: new Date(j.joinedAt) });
    const { result: r, autoIds } = await scanGroupFindings(
      {
        repo: s.repo,
        loadPhoto: async (url) => images[url] ?? null,
        sleep: async (ms) => void sleeps.push(ms),
        ...over.deps,
      },
      e,
      step({ payload: { messageLimit: 0, checkProfiles: true, ...over.payload } }),
    );
    return { r, s, asked, sleeps, autoIds };
  }

  const named = { jid: `${NAMED}@c.us`, isAdmin: false, isSuperAdmin: false };
  const imps = (s: { repo: { incidents: { kind: string }[] } }) =>
    s.repo.incidents.filter((i) => i.kind === 'scan.impersonator') as unknown as {
      severity: string;
      status: string;
      who: { number: string };
      details: Record<string, unknown>;
    }[];

  it('estranho com a foto oficial vira achado aberto e crítico; nome suspeito vira aviso; nada é feito no WhatsApp', async () => {
    const { r, s } = await run({
      pics: { [`${COMUM}@c.us`]: OFFICIAL, [`${NAMED}@c.us`]: OTHER },
      names: { [`${NAMED}@c.us`]: 'Suporte Oficial' },
      extra: [named],
    });
    expect(r.impersonators).toBe(2);
    expect(r.profilesChecked).toBe(2);
    expect(r.profilesSkipped).toBe(0);
    expect(r.findings).toBe(r.blacklisted + r.unknownAdmins + 2);
    const byNum = Object.fromEntries(imps(s).map((i) => [i.who.number, i]));
    expect(byNum[`+${COMUM}`]).toMatchObject({ status: 'open', severity: 'critical' });
    expect(byNum[`+${COMUM}`]!.details).toMatchObject({ reason: 'photo', matched: 'Arte oficial', jid: `${COMUM}@c.us` });
    expect(byNum[`+${NAMED}`]).toMatchObject({ status: 'open', severity: 'warning' });
    expect(byNum[`+${NAMED}`]!.details).toMatchObject({ reason: 'name', profileName: 'Suporte Oficial' });
    expect(s.calls).toEqual([]);
  });

  it('admin, allowlist e bloqueado nunca são consultados; admin com a foto oficial não gera achado', async () => {
    const { s, asked } = await run({
      pics: { [`${BAD_ADMIN}@c.us`]: OFFICIAL, [`${ADMIN_TEAM}@c.us`]: OFFICIAL, [`${BLOCKED}@c.us`]: OFFICIAL },
    });
    expect(imps(s)).toEqual([]);
    expect(asked).toEqual([`${COMUM}@c.us`]); // só o participante comum
  });

  it('checkProfiles falso, ou impersonation off: zero consultas', async () => {
    const off = await run({ payload: { checkProfiles: false }, pics: { [`${COMUM}@c.us`]: OFFICIAL } });
    expect(off.asked).toEqual([]);
    expect(off.r).toMatchObject({ impersonators: 0, profilesChecked: 0 });
    const cfgOff = await run({ cfg: { impersonation: 'off' }, pics: { [`${COMUM}@c.us`]: OFFICIAL } });
    expect(cfgOff.asked).toEqual([]);
    expect(imps(cfgOff.s)).toEqual([]);
  });

  it('anti-hacker desligado na campanha: nenhuma consulta de perfil, mesmo com impostor ligado', async () => {
    const off = await run({ cfg: { enabled: false }, pics: { [`${COMUM}@c.us`]: OFFICIAL } });
    expect(off.asked).toEqual([]);
    expect(off.r).toMatchObject({ impersonators: 0, profilesChecked: 0 });
    expect(imps(off.s)).toEqual([]);
  });

  it('consulta de nome falha: a foto ainda é avaliada (achado com nome null)', async () => {
    const ref = await photoHash(await art());
    const s = setup({
      antiHacker: { enabled: true, impersonation: 'review', impersonationPhotos: [{ label: 'Arte oficial', hash: ref }] },
    });
    const { e } = engineWith(info());
    e.getProfilePicture = async (_s, jid) => (jid === `${COMUM}@c.us` ? OFFICIAL : null);
    e.getContactName = async () => {
      throw new Error('WAHA 500');
    };
    const bytes = await art();
    const r = await scanGroup(
      { repo: s.repo, loadPhoto: async () => bytes, sleep: async () => {} },
      e,
      step({ payload: { messageLimit: 0, checkProfiles: true } }),
    );
    expect(r).toMatchObject({ impersonators: 1, profilesSkipped: 0 });
    expect(imps(s)[0]!.details).toMatchObject({ reason: 'photo', profileName: null });
  });

  it('consulta que falha soma em profilesSkipped e a varredura segue; pausa entre consultas', async () => {
    const { r, s, sleeps } = await run({
      pics: { [`${COMUM}@c.us`]: new Error('WAHA 500'), [`${NAMED}@c.us`]: OFFICIAL },
      extra: [named],
      deps: { profileGapMs: 300 },
    });
    expect(r).toMatchObject({ profilesSkipped: 1, profilesChecked: 1, impersonators: 1 });
    expect(imps(s).map((i) => i.who.number)).toEqual([`+${NAMED}`]);
    expect(sleeps).toEqual([300]); // 2 consultas → 1 pausa
  });

  it('LID sem telefone: consulta e achado usam o jid do participante', async () => {
    const { r, asked, s } = await run({
      pics: { '100000000000007@lid': OFFICIAL },
      extra: [{ jid: '100000000000007@lid', isAdmin: false, isSuperAdmin: false }],
    });
    expect(asked).toContain('100000000000007@lid');
    expect(r.impersonators).toBe(1);
    expect(imps(s)[0]!.details).toMatchObject({ jid: '100000000000007@lid' });
  });

  it('since: só consulta quem entrou na janela; sem linha em group_participants não é conferido; sem since, todos', async () => {
    const pics = { [`${COMUM}@c.us`]: OFFICIAL, [`${NAMED}@c.us`]: OFFICIAL };
    const joiners = [
      { who: NAMED, joinedAt: '2026-11-17T10:30:00.000Z' }, // dentro da janela
      { who: COMUM, joinedAt: '2026-11-10T10:00:00.000Z' }, // entrou antes da janela
    ];
    const since = '2026-11-17T10:00:00.000Z';
    const a = await run({ pics, extra: [named], joiners, payload: { since } });
    expect(a.asked).toEqual([`${NAMED}@c.us`]);
    expect(imps(a.s).map((i) => i.who.number)).toEqual([`+${NAMED}`]);
    const b = await run({ pics, extra: [named], payload: { since } }); // ninguém com linha: ninguém é conferido
    expect(b.asked).toEqual([]);
    const c = await run({ pics, extra: [named], joiners }); // sem since: todos
    expect(c.asked.sort()).toEqual([`${NAMED}@c.us`, `${COMUM}@c.us`].sort());
  });

  describe('achados que podem agir sozinhos (autoAct)', () => {
    const pics = { [`${COMUM}@c.us`]: OFFICIAL, [`${NAMED}@c.us`]: OTHER };
    const names = { [`${NAMED}@c.us`]: 'Suporte Oficial' };
    const go = (cfg: Record<string, unknown>) => run({ pics, names, extra: [named], cfg });

    it('modo review: achados abertos, nenhum elegível', async () => {
      const { r, autoIds } = await go({ impersonation: 'review', impersonationRemoveByName: true });
      expect(r.impersonators).toBe(2);
      expect(autoIds).toEqual([]);
    });

    it('auto: foto sempre elegível; nome só com impersonationRemoveByName', async () => {
      const off = await go({ impersonation: 'auto' });
      expect(off.autoIds).toHaveLength(1);
      expect(off.s.repo.incidents.find((i) => i.id === off.autoIds[0])!.details).toMatchObject({ reason: 'photo' });
      const on = await go({ impersonation: 'auto', impersonationRemoveByName: true });
      expect(on.autoIds).toHaveLength(2);
      // modo simulação: nada age sozinho, nem com foto igual
      const dry = await go({ impersonation: 'auto', impersonationRemoveByName: true, dryRun: true });
      expect(dry.autoIds).toEqual([]);
    });
  });

  it('motor sem getProfilePicture: não consulta e não quebra', async () => {
    const s = setup({ antiHacker: { enabled: true, impersonation: 'review' } });
    const { e } = engineWith(info());
    const r = await scanGroup({ repo: s.repo }, e, step({ payload: { messageLimit: 0, checkProfiles: true } }));
    expect(r).toMatchObject({ impersonators: 0, profilesChecked: 0 });
  });
});
