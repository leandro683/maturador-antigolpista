import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createAccountsService } from '@mag/accounts';
import { DrizzleSecRepo, identityOf } from '@mag/module-security';
import { campaigns, groupParticipants, groups } from '@mag/db/schema';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import { FakeEngine } from '@mag/wa-engine/fake';
import { GruposError, createGruposService, gruposService } from '@/server/services/grupos';

const auth = vi.hoisted(() => ({ ok: true }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => {
    if (!auth.ok) throw new Error('NEXT_REDIRECT');
    return { id: 'admin' };
  },
}));
vi.mock('@/server/db', () => ({ serverDb: () => {
  throw new Error('não deve abrir o banco sem sessão');
} }));
vi.mock('@/server/engine', () => ({ serverEngine: () => null }));

const N = (n: number) => `55119999900${String(n).padStart(2, '0')}@c.us`; // telefone de teste
const E164 = (n: number) => `+55119999900${String(n).padStart(2, '0')}`;

describe.skipIf(!PG_URL)('serviço de operações e grupos — Postgres real + FakeEngine', () => {
  let t: Awaited<ReturnType<typeof freshDb>>;
  let engine: FakeEngine;
  let svc: ReturnType<typeof createGruposService>;
  let opId: string;
  let chipId: string;
  let session: string;

  beforeAll(async () => {
    t = await freshDb();
    engine = new FakeEngine();
    svc = createGruposService(t.db, engine);
    const contas = createAccountsService(t.db, engine);
    const chip = await contas.create({ name: 'Chip 1' });
    chipId = chip.id;
    session = chip.sessionName;
    await engine.createSession(session);
    opId = (await svc.criar('  Operação A ')).id;
    await svc.definirChips(opId, [chipId, chipId, '00000000-0000-0000-0000-000000000000']);
  });
  afterAll(async () => {
    await t.drop();
  });

  const gruposDe = (id: string) => t.db.select().from(groups).where(eq(groups.campaignId, id));
  const ativos = (groupId: string) =>
    t.db
      .select()
      .from(groupParticipants)
      .where(and(eq(groupParticipants.groupId, groupId), isNull(groupParticipants.leftAt)));

  it('criar/renomear/arquivar/chips: valida nome, ignora conta inexistente e repetida', async () => {
    await expect(svc.criar('   ')).rejects.toBeInstanceOf(GruposError);
    const op = (await svc.get(opId))!;
    expect(op.name).toBe('Operação A');
    expect(op.accountIds).toEqual([chipId]);
    await svc.renomear(opId, 'Operação A2');
    expect((await svc.get(opId))!.name).toBe('Operação A2');
    await svc.arquivar(opId, true);
    expect((await svc.listar()).map((o) => o.id)).not.toContain(opId);
    expect((await svc.listar({ arquivadas: true })).map((o) => o.id)).toContain(opId);
    await svc.arquivar(opId, false);
    await expect(svc.renomear('00000000-0000-0000-0000-000000000000', 'x')).rejects.toBeInstanceOf(GruposError);
  });

  it('importar grava groups (campanha, chip, gid, nome) e os participantes', async () => {
    const { gid } = await engine.createGroup(session, { subject: 'Grupo Um', participants: [N(2), N(3)] });
    await engine.promote(session, gid, [N(2)]);

    const r = await svc.importar(opId, chipId, [gid]);
    expect(r).toEqual({ imported: 1, updated: 0, skipped: 0, failed: 0 });

    const [g] = await gruposDe(opId);
    expect(g).toMatchObject({ gid, name: 'Grupo Um', waAccountId: chipId, campaignId: opId });
    expect(g!.participantsAmount).toBe(3); // o próprio chip + 2
    expect(g!.adminsAmount).toBe(2); // o chip (criador) e o promovido
    expect((await svc.listar()).find((o) => o.id === opId)!.grupos).toBe(1); // a lista de operações mostra quantos grupos tem
    const rows = await ativos(g!.id);
    expect(rows.map((p) => p.phone)).toContain(E164(2));
    expect(rows.find((p) => p.phone === E164(2))!.isAdmin).toBe(true);
    expect(rows.find((p) => p.phone === E164(3))!.isAdmin).toBe(false);
  });

  it('importar não marca quem já estava no grupo como recém-chegado (a análise automática só olha quem entra depois)', async () => {
    const op = (await svc.criar('Operação Antiga')).id; // própria, para não mexer nos grupos dos outros testes
    await svc.definirChips(op, [chipId]);
    const { gid } = await engine.createGroup(session, { subject: 'Grupo Antigo', participants: [N(7), N(8)] });
    await svc.importar(op, chipId, [gid]);
    const g = (await gruposDe(op))[0]!;
    const repo = new DrizzleSecRepo(t.db);
    const dia = () => new Date(Date.now() - 48 * 3_600_000);
    expect((await ativos(g.id)).every((p) => p.joinedAt === null)).toBe(true);
    expect((await repo.recentJoiners(g.id, dia())).size).toBe(0);

    // reimportar também não carimba; quem o worker viu entrar depois continua contando
    await engine.addParticipants(session, gid, [N(9)]);
    await svc.importar(op, chipId, [gid]);
    expect((await repo.recentJoiners(g.id, dia())).size).toBe(0);
    await t.db.update(groupParticipants).set({ joinedAt: new Date() }).where(and(eq(groupParticipants.groupId, g.id), eq(groupParticipants.phone, E164(9))));
    const depois = await repo.recentJoiners(g.id, dia());
    expect(depois.has(identityOf(E164(9)))).toBe(true);
    expect(depois.has(identityOf(E164(7)))).toBe(false);
    await svc.removerGrupo(g.id);
    engine.groups.delete(gid); // o chip deixa de enxergá-lo
  });

  it('reimportar não duplica; reflete quem entrou e quem saiu', async () => {
    const [g0] = await gruposDe(opId);
    await engine.addParticipants(session, g0!.gid, [N(4)]);
    await engine.removeParticipants(session, g0!.gid, [N(3)]);

    const r = await svc.importar(opId, chipId, [g0!.gid, g0!.gid]);
    expect(r).toEqual({ imported: 0, updated: 1, skipped: 0, failed: 0 });

    const todos = await gruposDe(opId);
    expect(todos).toHaveLength(1);
    const todosParts = await t.db.select().from(groupParticipants).where(eq(groupParticipants.groupId, g0!.id));
    expect(new Set(todosParts.map((p) => p.phone)).size).toBe(todosParts.length); // sem linha repetida
    const vivos = (await ativos(g0!.id)).map((p) => p.phone);
    expect(vivos).toContain(E164(4));
    expect(vivos).not.toContain(E164(3));
    expect(todosParts.find((p) => p.phone === E164(3))!.leftAt).not.toBeNull();
    expect(todos[0]!.participantsAmount).toBe(vivos.length);
  });

  it('grupo que já é de outra operação é pulado; gid inválido conta como falha; chip fora da operação é recusado', async () => {
    const outra = (await svc.criar('Operação B')).id;
    await svc.definirChips(outra, [chipId]);
    const [g0] = await gruposDe(opId);
    expect(await svc.importar(outra, chipId, [g0!.gid, 'nao-e-gid', '5511999990002@c.us'])).toEqual({
      imported: 0,
      updated: 0,
      skipped: 1,
      failed: 2,
    });
    expect(await gruposDe(outra)).toHaveLength(0);

    const sem = (await svc.criar('Operação C')).id; // sem chips
    await expect(svc.importar(sem, chipId, [g0!.gid])).rejects.toBeInstanceOf(GruposError);
    await expect(svc.buscarGrupos(sem, chipId)).rejects.toBeInstanceOf(GruposError);
  });

  it('grupo que o WhatsApp não encontra conta como falha, sem derrubar os outros', async () => {
    const { gid } = await engine.createGroup(session, { subject: 'Grupo Dois', participants: [N(5)] });
    const r = await svc.importar(opId, chipId, ['1203630000000099@g.us', gid]);
    expect(r).toEqual({ imported: 1, updated: 0, skipped: 0, failed: 1 });
  });

  it('mais de 200 grupos de uma vez é recusado com aviso (nada é descartado em silêncio)', async () => {
    const muitos = Array.from({ length: 201 }, (_, i) => `1203630${String(i).padStart(9, '0')}@g.us`);
    await expect(svc.importar(opId, chipId, muitos)).rejects.toThrow('Selecione no máximo 200 grupos por vez.');
    const total = async () => (await t.db.select({ n: sql<number>`count(*)::int` }).from(groups))[0]!.n;
    const antes = await total();
    expect(antes).toBeGreaterThan(0);
    await expect(svc.importar(opId, chipId, muitos)).rejects.toBeInstanceOf(GruposError);
    expect(await total()).toBe(antes); // nada novo foi gravado
  });

  it('resposta do motor sem nenhum participante conta como falha e não zera os participantes salvos', async () => {
    const [g0] = await gruposDe(opId);
    const antes = (await ativos(g0!.id)).length;
    const original = engine.getGroup.bind(engine);
    engine.getGroup = async (s, gid) => ({ ...(await original(s, gid)), participants: [] });
    try {
      expect(await svc.importar(opId, chipId, [g0!.gid])).toEqual({ imported: 0, updated: 0, skipped: 0, failed: 1 });
    } finally {
      engine.getGroup = original;
    }
    expect((await ativos(g0!.id)).length).toBe(antes);
  });

  it('buscarGrupos lista o que o chip enxerga e marca os monitorados', async () => {
    const outra = (await svc.listar()).find((o) => o.name === 'Operação B')!.id;
    const naA = await svc.buscarGrupos(opId, chipId);
    expect(naA.map((g) => [g.name, g.monitored])).toEqual([
      ['Grupo Dois', 'esta'],
      ['Grupo Um', 'esta'],
    ]);
    const naB = await svc.buscarGrupos(outra, chipId);
    expect(naB.every((g) => g.monitored === 'outra')).toBe(true);
    expect(naA[1]!.participants).toBeGreaterThan(0);
  });

  it('removerGrupo apaga o grupo e os participantes dele', async () => {
    const [g] = await gruposDe(opId);
    await svc.removerGrupo(g!.id);
    expect(await t.db.select().from(groups).where(eq(groups.id, g!.id))).toHaveLength(0);
    expect(await t.db.select().from(groupParticipants).where(eq(groupParticipants.groupId, g!.id))).toHaveLength(0);
    expect(await t.db.select().from(campaigns).where(eq(campaigns.id, opId))).toHaveLength(1);
  });

  it('sem motor do WhatsApp configurado: buscar/importar avisam, o resto continua', async () => {
    const semMotor = createGruposService(t.db, null);
    await expect(semMotor.buscarGrupos(opId, chipId)).rejects.toThrow(/não configurado/);
    expect((await semMotor.listar()).length).toBeGreaterThan(0);
  });
});

describe('gruposService (porta do painel)', () => {
  it('exige sessão de admin antes de abrir o banco', async () => {
    auth.ok = false;
    await expect(gruposService()).rejects.toThrow('NEXT_REDIRECT');
    auth.ok = true;
  });
});
