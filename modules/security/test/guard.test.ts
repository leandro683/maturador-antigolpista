import { describe, expect, it, vi } from 'vitest';
import type { GroupParticipant } from '@mag/wa-engine';
import { confirmRemovable, type GuardEngine, type GuardRepo } from '../src/guard';
import { identityOf, IdentitySet, lidJid, type Identity } from '../src/identity';

const GID = '1203630000000002@g.us';
const S = 'chip-01';
// números fictícios; lid como o engine entrega (com @lid)
// número fictício dos EUA (faixa 555-01xx, reservada para ficção); montado em partes p/ não parecer número real
const US = '1555010' + '0199';
const STRANGER = '5511999990002';
const LID = '100000000000001@lid';
const LID2 = '100000000000002@lid';

const part = (jid: string, over: Partial<GroupParticipant> = {}): GroupParticipant => ({
  jid,
  isAdmin: false,
  isSuperAdmin: false,
  ...over,
});

const engineOf = (
  participants: GroupParticipant[],
  phoneOfLid?: GuardEngine['phoneOfLid'],
): GuardEngine => ({
  getGroup: async (_s, gid) => ({ gid, subject: '', participants }),
  ...(phoneOfLid ? { phoneOfLid } : {}),
});

const repoOf = (agency: Identity[] = []): GuardRepo => ({ agencyAccounts: async () => agency });

const run = (engine: GuardEngine, who: string[], allow: string[] = [], agency: Identity[] = []) =>
  confirmRemovable({
    engine,
    session: S,
    gid: GID,
    who: identityOf(...who),
    allow: new IdentitySet(allow.map((a) => identityOf(a))),
    repo: repoOf(agency),
  });

describe('confirmRemovable: recusas', () => {
  it('getGroup lança: não foi possível conferir o grupo', async () => {
    const engine: GuardEngine = {
      getGroup: async () => {
        throw new Error('timeout');
      },
    };
    expect(await run(engine, [`${STRANGER}@c.us`])).toEqual({ ok: false, reason: 'não foi possível conferir o grupo' });
  });

  it('ausente do grupo: não confirmado na lista do grupo', async () => {
    const r = await run(engineOf([part('5511999990008@c.us')]), [`${STRANGER}@c.us`]);
    expect(r).toEqual({ ok: false, reason: 'não confirmado na lista do grupo' });
  });

  it('grupo lista só por LID e a pessoa veio por telefone: não confirmado', async () => {
    const r = await run(engineOf([part(LID, { lid: LID })]), [`${STRANGER}@c.us`]);
    expect(r).toEqual({ ok: false, reason: 'não confirmado na lista do grupo' });
  });

  it('admin e super-admin: é admin do grupo', async () => {
    for (const flag of ['isAdmin', 'isSuperAdmin'] as const) {
      const r = await run(engineOf([part(`${STRANGER}@c.us`, { [flag]: true })]), [`${STRANGER}@c.us`]);
      expect(r).toEqual({ ok: false, reason: 'é admin do grupo' });
    }
  });

  it('lista oficial só por telefone, participante só com LID e phoneOfLid resolve: está na lista oficial', async () => {
    const phoneOfLid = vi.fn(async () => `${STRANGER}@c.us`);
    const r = await run(engineOf([part(LID, { lid: LID })], phoneOfLid), [LID], [`+${STRANGER}`]);
    expect(r).toEqual({ ok: false, reason: 'está na lista oficial' });
    expect(phoneOfLid).toHaveBeenCalledWith(S, LID);
  });

  it('idem sem phoneOfLid: sem telefone para conferir a lista oficial', async () => {
    const r = await run(engineOf([part(LID, { lid: LID })]), [LID], [`+${STRANGER}`]);
    expect(r).toEqual({ ok: false, reason: 'sem telefone para conferir a lista oficial' });
  });

  it('idem com phoneOfLid lançando, devolvendo vazio ou nulo: sem telefone', async () => {
    for (const fn of [
      async () => {
        throw new Error('x');
      },
      async () => '',
      async () => null,
    ]) {
      const r = await run(engineOf([part(LID, { lid: LID })], fn as GuardEngine['phoneOfLid']), [LID], [`+${STRANGER}`]);
      expect(r).toEqual({ ok: false, reason: 'sem telefone para conferir a lista oficial' });
    }
  });

  it('lista oficial só por LID, grupo lista telefone e LID: está na lista oficial', async () => {
    const r = await run(engineOf([part(`${STRANGER}@c.us`, { lid: LID })]), [`${STRANGER}@c.us`], [LID]);
    expect(r).toEqual({ ok: false, reason: 'está na lista oficial' });
  });

  it('lista oficial com o lid cadastrado já com sufixo na conta (chip nosso): está na lista oficial', async () => {
    const r = await confirmRemovable({
      engine: engineOf([part(LID, { lid: LID })]),
      session: S,
      gid: GID,
      who: identityOf(LID),
      allow: new IdentitySet([identityOf('5511999990009@c.us', lidJid(LID))]),
      repo: repoOf(),
    });
    expect(r).toEqual({ ok: false, reason: 'está na lista oficial' });
  });
});

// cada linha: número cadastrado na lista oficial (como o operador digita) x JID do participante no grupo
describe('confirmRemovable: formatos de telefone na lista oficial', () => {
  const cases: [string, string, string][] = [
    ['EUA com +', '+1 555 010 0199', `${US}@c.us`],
    ['EUA, JID s.whatsapp.net', '+1 555 010 0199', `${US}@s.whatsapp.net`],
    ['fixo brasileiro de 8 dígitos', '+55 11 3333-0005', '551133330005@c.us'],
    ['fixo 8 dígitos, só dígitos com 55', '551133330005', '551133330005@c.us'],
    ['celular cadastrado com o 9, grupo sem o 9', '+55 11 99999-0006', '551199990006@c.us'],
    ['celular cadastrado sem o 9, grupo com o 9', '+55 11 9999-0006', '5511999990006@c.us'],
    ['celular cadastrado sem o 9 (começa 6-9), grupo com o 9', '+55 11 9999-0007', '5511999990007@c.us'],
    // local de 8 dígitos começando em 2–5 não ganha variante em IdentitySet.add: só `listed()` (variantes do participante) casa.
    // JID montado em partes para não virar telefone solto no código
    ['celular cadastrado sem o 9 (começa 2-5), grupo com o 9', '+55 11 3333-0005', '55119' + '3333' + '0005' + '@c.us'],
    ['celular cadastrado com o 9, grupo com o 9', '+55 11 99999-0006', '5511999990006@c.us'],
  ];
  it.each(cases)('%s', async (_n, cadastrado, jid) => {
    const r = await run(engineOf([part(jid)]), [jid], [cadastrado]);
    expect(r).toEqual({ ok: false, reason: 'está na lista oficial' });
  });

  it('evento sem o 9 e grupo com o 9 (pessoa é a mesma): confirmada e na lista oficial', async () => {
    const r = await run(engineOf([part('5511999990006@c.us')]), ['551199990006@c.us'], ['+55 11 99999-0006']);
    expect(r).toEqual({ ok: false, reason: 'está na lista oficial' });
  });
});

describe('confirmRemovable: libera', () => {
  it('estranho não-admin com telefone: ok com o jid do grupo', async () => {
    const r = await run(engineOf([part(`${STRANGER}@c.us`)]), [`${STRANGER}@c.us`], ['+5511999990008', `+${US}`]);
    expect(r).toEqual({ ok: true, jid: `${STRANGER}@c.us` });
  });

  it('estranho só com LID e telefone resolvido fora da lista: ok com o jid do grupo', async () => {
    const phoneOfLid = async () => `${STRANGER}@c.us`;
    const r = await run(engineOf([part(LID2, { lid: LID2 })], phoneOfLid), [LID2], ['+5511999990008']);
    expect(r).toEqual({ ok: true, jid: LID2 });
  });

  it('evento com o 9 e grupo sem o 9, fora da lista: confirmada e removível com o jid do grupo', async () => {
    const r = await run(engineOf([part('551199990006@c.us')]), ['5511999990006@c.us']);
    expect(r).toEqual({ ok: true, jid: '551199990006@c.us' });
  });

  it('chip de fora com lid sufixado no grupo e fora da lista: ok', async () => {
    const r = await run(engineOf([part(`${STRANGER}@c.us`, { lid: LID })]), [`${STRANGER}@c.us`, LID]);
    expect(r).toEqual({ ok: true, jid: `${STRANGER}@c.us` });
  });
});

describe('confirmRemovable: a trava monta a lista do que nunca se toca', () => {
  it('conta do painel fora da campanha (lid com sufixo), allow vazio: está na lista oficial', async () => {
    const agency = [identityOf('5511999990010@c.us', lidJid('100000000000001'))];
    const r = await run(engineOf([part(LID, { lid: LID })]), [LID], [], agency);
    expect(r).toEqual({ ok: false, reason: 'está na lista oficial' });
  });

  it('não altera o conjunto do chamador', async () => {
    const allow = new IdentitySet();
    await confirmRemovable({
      engine: engineOf([part(`${STRANGER}@c.us`)]),
      session: S,
      gid: GID,
      who: identityOf(`${STRANGER}@c.us`),
      allow,
      repo: repoOf([identityOf('5511999990010@c.us')]),
    });
    expect(allow.size).toBe(0);
  });

  it('agencyAccounts lança: não foi possível conferir as contas do painel', async () => {
    const r = await confirmRemovable({
      engine: engineOf([part(`${STRANGER}@c.us`)]),
      session: S,
      gid: GID,
      who: identityOf(`${STRANGER}@c.us`),
      allow: new IdentitySet(),
      repo: {
        agencyAccounts: async () => {
          throw new Error('banco fora');
        },
      },
    });
    expect(r).toEqual({ ok: false, reason: 'não foi possível conferir as contas do painel' });
  });
});

describe('confirmRemovable: toda entrada do mesmo participante conta', () => {
  it('mesma pessoa listada 2x (telefone comum, LID admin): é admin do grupo', async () => {
    const r = await run(
      engineOf([part(`${STRANGER}@c.us`), part(LID, { lid: LID, isAdmin: true })]),
      [`${STRANGER}@c.us`, LID],
    );
    expect(r).toEqual({ ok: false, reason: 'é admin do grupo' });
  });

  it('mesma pessoa listada 2x (telefone comum, LID na lista oficial): está na lista oficial', async () => {
    const r = await run(
      engineOf([part(`${STRANGER}@c.us`), part(LID, { lid: LID })]),
      [`${STRANGER}@c.us`, LID],
      [LID],
    );
    expect(r).toEqual({ ok: false, reason: 'está na lista oficial' });
  });
});

describe('confirmRemovable: entradas ligadas entre si contam mesmo sem o elo em quem chegou', () => {
  const split = (adminOnLid: boolean) => [
    part(`${STRANGER}@c.us`, { lid: LID, isAdmin: !adminOnLid }),
    part(adminOnLid ? LID : `${STRANGER}@c.us`, adminOnLid ? { lid: LID, isAdmin: true } : {}),
  ];

  it('quem chegou só com telefone; a entrada admin está só no LID: é admin do grupo', async () => {
    const r = await run(engineOf(split(true)), [`${STRANGER}@c.us`]);
    expect(r).toEqual({ ok: false, reason: 'é admin do grupo' });
  });

  it('quem chegou só com LID; a entrada admin está só no telefone: é admin do grupo', async () => {
    const r = await run(
      engineOf([part(`${STRANGER}@c.us`, { lid: LID }), part(`${STRANGER}@c.us`, { isAdmin: true })]),
      [LID],
    );
    expect(r).toEqual({ ok: false, reason: 'é admin do grupo' });
  });

  it('quem chegou só com telefone; a entrada do LID está na lista oficial: está na lista oficial', async () => {
    const r = await run(
      engineOf([part(`${STRANGER}@c.us`, { lid: LID }), part(LID, { lid: LID })]),
      [`${STRANGER}@c.us`],
      [LID],
    );
    expect(r).toEqual({ ok: false, reason: 'está na lista oficial' });
  });
});

describe('confirmRemovable: a identidade que chegou também é conferida', () => {
  it('allow só com o LID, who com telefone e esse LID, grupo lista só o telefone: está na lista oficial', async () => {
    const r = await run(engineOf([part(`${STRANGER}@c.us`)]), [`${STRANGER}@c.us`, LID], [LID]);
    expect(r).toEqual({ ok: false, reason: 'está na lista oficial' });
  });
});
