import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { actions, actionSteps, campaigns, groups, waAccounts } from '@mag/db/schema';
import { FakeEngine } from '@mag/wa-engine/fake';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import { DrizzleSecRepo } from '../src/repo';
import { activeScan, listScans, SECURITY_SCAN_TYPE, startScan } from '../src/scan';
import { cancelScan, runScanChild, scanCreator, SEC_SCAN_QUEUE, STALE_MS, sweepStaleScans } from '../src/scan-run';
import { incidents } from '../src/tables';

/** telefone de teste (padrão fictício) do participante `i` */
const phone = (i: number) => `55119999900${String(i + 10).padStart(2, '0')}`;

type Key = 'main' | 'main2' | 'spy' | 'off';

/** Runner da varredura no Postgres real: cria pai/filhos/passos, roda 1 grupo por chamada, cancela. */
describe.skipIf(!PG_URL)('scan-run no Postgres', () => {
  let db: Db;
  let drop: () => Promise<void>;
  const engine = new FakeEngine();
  const deps = () => ({ db, engine, scan: { repo: new DrizzleSecRepo(db), sleep: async () => {} } });
  let n = 0;
  let seq = 0;

  /** campanha com contas (main e main2 conectadas; spy conectada e espiã; off desconectada) e um grupo por item de `groupsOf` */
  async function mk(opts: { accounts?: Key[]; groupsOf: (Key | null)[] }) {
    n += 1;
    const acc: Record<string, string> = {};
    for (const [key, status, role] of [
      ['main', 'active', 'both'],
      ['main2', 'active', 'both'],
      ['spy', 'active', 'spy'],
      ['off', 'disconnected', 'both'],
    ] as const) {
      const [a] = await db
        .insert(waAccounts)
        .values({ name: key, sessionName: `${key}-${n}`, jid: `5511999${String(++seq).padStart(6, '0')}@c.us`, status, rolePolicy: { role } })
        .returning();
      acc[key] = a!.id;
      await engine.createSession(`${key}-${n}`);
    }
    const [c] = await db
      .insert(campaigns)
      .values({ name: `Camp ${n}`, slug: `camp-${n}`, accountIds: (opts.accounts ?? ['main', 'main2', 'spy', 'off']).map((k) => acc[k]!) })
      .returning();
    const gs: { id: string; gid: string }[] = [];
    for (const [i, owner] of opts.groupsOf.entries()) {
      const { gid } = await engine.createGroup(`main-${n}`, { subject: `G${i}`, participants: [`${phone(i)}@c.us`] });
      // o criador do grupo no fake entra como admin; aqui o grupo começa só com 1 participante comum
      engine.groups.get(gid)!.participants = [{ jid: `${phone(i)}@c.us`, isAdmin: false, isSuperAdmin: false }];
      const [g] = await db
        .insert(groups)
        .values({ campaignId: c!.id, waAccountId: owner ? acc[owner]! : null, name: `G${i}`, gid })
        .returning();
      gs.push({ id: g!.id, gid });
    }
    return { acc, camp: c!.id, gs };
  }

  const childrenOf = (parentId: string) => db.select().from(actions).where(eq(actions.parentId, parentId));
  const stepsOf = (actionId: string) => db.select().from(actionSteps).where(eq(actionSteps.actionId, actionId));
  const rowOf = async (id: string) => (await db.select().from(actions).where(eq(actions.id, id)))[0]!;

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
  });
  afterAll(async () => drop?.());

  it('fila fixa', () => expect(SEC_SCAN_QUEUE).toBe('sec-scan'));

  it('scanCreator: pai + um filho por conta + um passo por grupo; enfileira cada filho', async () => {
    const t = await mk({ groupsOf: ['main', 'main2', 'main'] });
    const queued: string[] = [];
    const id = await startScan(db, scanCreator(db, async (c) => void queued.push(c)), t.camp, { messageLimit: 10 });
    expect(await rowOf(id)).toMatchObject({
      type: SECURITY_SCAN_TYPE,
      campaignId: t.camp,
      parentId: null,
      status: 'queued',
      total: 3,
      payload: { messageLimit: 10, checkProfiles: false, autoAct: false },
    });
    const kids = await childrenOf(id);
    expect(kids.map((k) => k.waAccountId).sort()).toEqual([t.acc.main, t.acc.main2].sort());
    expect(kids.every((k) => k.status === 'queued' && k.type === SECURITY_SCAN_TYPE)).toBe(true);
    expect(queued.sort()).toEqual(kids.map((k) => k.id).sort());
    const byAcc = Object.fromEntries(kids.map((k) => [k.waAccountId, k]));
    expect(byAcc[t.acc.main!]!.total).toBe(2);
    expect((await stepsOf(byAcc[t.acc.main2!]!.id)).map((s) => s.target)).toEqual([t.gs[1]!.gid]);
    expect(await activeScan(db, t.camp)).toBe(id);
  });

  it('conta do grupo desconectada, espiã ou ausente: usa a primeira conta apta da operação', async () => {
    const t = await mk({ groupsOf: ['off', 'spy', null] });
    const queued: string[] = [];
    const id = await startScan(db, scanCreator(db, async (c) => void queued.push(c)), t.camp);
    const kids = await childrenOf(id);
    expect(kids).toHaveLength(1);
    expect(kids[0]!.waAccountId).toBe(t.acc.main);
    expect(kids[0]!.total).toBe(3);
    expect(queued).toEqual([kids[0]!.id]);
  });

  it('sem conta apta: erro em português e nada é gravado', async () => {
    const t = await mk({ accounts: ['spy', 'off'], groupsOf: ['off'] });
    await expect(startScan(db, scanCreator(db, async () => {}), t.camp)).rejects.toThrow(/nenhuma conta conectada/);
    expect(await activeScan(db, t.camp)).toBeNull();
    expect(await listScans(db, { campaignId: t.camp })).toEqual([]);
  });

  it('runScanChild: 1 grupo por chamada, grava achado e resultado, fecha filho e pai', async () => {
    const t = await mk({ groupsOf: ['main', 'main'] });
    // admin desconhecido no 1º grupo: achado `scan.unknown-admin`
    engine.groups.get(t.gs[0]!.gid)!.participants.push({ jid: '5511999990099@c.us', isAdmin: true, isSuperAdmin: false });
    const id = await startScan(db, scanCreator(db, async () => {}), t.camp, { messageLimit: 0 });
    const [child] = await childrenOf(id);

    expect(await runScanChild(deps(), child!.id)).toEqual({ more: true });
    expect(await rowOf(child!.id)).toMatchObject({ status: 'processing', total: 2, processed: 1, success: 1, failed: 0 });
    expect(await rowOf(id)).toMatchObject({ status: 'processing', total: 2, processed: 1, success: 1 });
    expect((await stepsOf(child!.id)).filter((s) => s.status === 'success' && s.attempts === 1)).toHaveLength(1);

    expect(await runScanChild(deps(), child!.id)).toEqual({ more: false });
    const withAdmin = (await stepsOf(child!.id)).find((s) => s.target === t.gs[0]!.gid)!;
    expect(withAdmin.result).toMatchObject({ participants: 2, unknownAdmins: 1, findings: 1 });
    const c = await rowOf(child!.id);
    expect(c).toMatchObject({ status: 'success', processed: 2, success: 2 });
    expect(c.finishedAt).not.toBeNull();
    const p = await rowOf(id);
    expect(p).toMatchObject({ status: 'success', processed: 2 });
    expect(p.finishedAt).not.toBeNull();

    const inc = await db.select().from(incidents).where(eq(incidents.groupId, t.gs[0]!.id));
    expect(inc.map((i) => i.kind)).toEqual(['scan.unknown-admin']);
    expect((inc[0]!.details as { scanId: string }).scanId).toBe(id);
    const [view] = await listScans(db, { campaignId: t.camp });
    expect(view).toMatchObject({ id, status: 'success', total: 2, processed: 2, failed: 0, findings: 1, active: false });
    expect(await activeScan(db, t.camp)).toBeNull();
    // nada pendente: nova chamada não faz nada
    expect(await runScanChild(deps(), child!.id)).toEqual({ more: false });
  });

  it('erro do passo (grupo some do WhatsApp) fica gravado; filho e pai terminam em failed', async () => {
    const t = await mk({ groupsOf: ['main', 'main'] });
    engine.groups.delete(t.gs[1]!.gid);
    const id = await startScan(db, scanCreator(db, async () => {}), t.camp, { messageLimit: 0 });
    const [child] = await childrenOf(id);
    expect(await runScanChild(deps(), child!.id)).toEqual({ more: true });
    expect(await runScanChild(deps(), child!.id)).toEqual({ more: false });
    const bad = (await stepsOf(child!.id)).find((s) => s.status === 'failed')!;
    expect(bad.error).toMatch(/inexistente/);
    expect(bad.target).toBe(t.gs[1]!.gid);
    expect(await rowOf(child!.id)).toMatchObject({ status: 'failed', processed: 2, success: 1, failed: 1 });
    expect(await rowOf(id)).toMatchObject({ status: 'failed', failed: 1 });
  });

  const ago = (ms: number) => new Date(Date.now() - ms);

  it('passo `processing` velho (worker morreu) volta a pendente e é refeito', async () => {
    const t = await mk({ groupsOf: ['main'] });
    const id = await startScan(db, scanCreator(db, async () => {}), t.camp, { messageLimit: 0 });
    const [child] = await childrenOf(id);
    await db
      .update(actionSteps)
      .set({ status: 'processing', attempts: 1, updatedAt: ago(STALE_MS + 60_000) })
      .where(eq(actionSteps.actionId, child!.id));
    expect(await runScanChild(deps(), child!.id)).toEqual({ more: false });
    const [s] = await stepsOf(child!.id);
    expect(s).toMatchObject({ status: 'success', attempts: 2 });
  });

  it('passo `processing` recente (outro worker está nele) não é tocado nem refeito', async () => {
    const t = await mk({ groupsOf: ['main', 'main'] });
    const id = await startScan(db, scanCreator(db, async () => {}), t.camp, { messageLimit: 0 });
    const [child] = await childrenOf(id);
    const [first] = await stepsOf(child!.id);
    await db.update(actionSteps).set({ status: 'processing', attempts: 1, updatedAt: ago(30_000) }).where(eq(actionSteps.id, first!.id));
    const spy = vi.spyOn(engine, 'getGroup');
    try {
      expect(await runScanChild(deps(), child!.id)).toEqual({ more: false });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect((await stepsOf(child!.id)).map((x) => x.status).sort()).toEqual(['pending', 'processing']);
  });

  it('chamadas ao mesmo filho ao mesmo tempo: cada grupo é consultado uma vez só', async () => {
    const t = await mk({ groupsOf: ['main', 'main'] });
    const id = await startScan(db, scanCreator(db, async () => {}), t.camp, { messageLimit: 0 });
    const [child] = await childrenOf(id);
    const real = engine.getGroup.bind(engine);
    const spy = vi.spyOn(engine, 'getGroup').mockImplementation(async (s, gid) => {
      await new Promise((r) => setTimeout(r, 150));
      return real(s, gid);
    });
    try {
      const out = await Promise.all([runScanChild(deps(), child!.id), runScanChild(deps(), child!.id), runScanChild(deps(), child!.id)]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(out.filter((o) => o.more)).toHaveLength(1);
      const steps = await stepsOf(child!.id);
      expect(steps.filter((x) => x.status === 'success' && x.attempts === 1)).toHaveLength(1);
      expect(steps.filter((x) => x.status === 'pending')).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  /** db cujos `update().set()` lançam enquanto `state.fail(valores)` disser que sim (queda do banco no meio do passo) */
  const flaky = (state: { fail: (v: Record<string, unknown>) => boolean }): Db =>
    new Proxy(db, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (prop !== 'update') return typeof v === 'function' ? v.bind(target) : v;
        return (table: Parameters<Db['update']>[0]) => {
          const b = target.update(table);
          return {
            set: (vals: Record<string, unknown>) => {
              if (state.fail(vals)) throw new Error('conexão perdida');
              return b.set(vals as never);
            },
          };
        };
      },
    });

  it('erro fora do try do passo (gravar o resultado): passo volta a pendente e a chamada seguinte continua', async () => {
    const t = await mk({ groupsOf: ['main'] });
    const id = await startScan(db, scanCreator(db, async () => {}), t.camp, { messageLimit: 0 });
    const [child] = await childrenOf(id);
    let once = true;
    const bad = flaky({ fail: (v) => v.status === 'success' && once && !(once = false) });
    await expect(runScanChild({ ...deps(), db: bad }, child!.id)).rejects.toThrow('conexão perdida');
    expect((await stepsOf(child!.id))[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await rowOf(child!.id)).toMatchObject({ status: 'processing' });
    expect(await runScanChild(deps(), child!.id)).toEqual({ more: false });
    expect((await stepsOf(child!.id))[0]).toMatchObject({ status: 'success', attempts: 2 });
    expect(await rowOf(id)).toMatchObject({ status: 'success' });
  });

  it('erro fora do try do passo e o banco continua fora (nem a volta a pendente grava): o passo velho é retomado depois', async () => {
    const t = await mk({ groupsOf: ['main'] });
    const id = await startScan(db, scanCreator(db, async () => {}), t.camp, { messageLimit: 0 });
    const [child] = await childrenOf(id);
    let down = false;
    const bad = flaky({ fail: (v) => down && (v.status === 'success' || v.status === 'pending') });
    const real = engine.getGroup.bind(engine);
    const spy = vi.spyOn(engine, 'getGroup').mockImplementation(async (s, gid) => {
      down = true;
      return real(s, gid);
    });
    try {
      await expect(runScanChild({ ...deps(), db: bad }, child!.id)).rejects.toThrow('conexão perdida');
    } finally {
      spy.mockRestore();
    }
    expect((await stepsOf(child!.id))[0]).toMatchObject({ status: 'processing' });
    expect(await runScanChild(deps(), child!.id)).toEqual({ more: false }); // ainda recente: nada a fazer
    await db.update(actionSteps).set({ updatedAt: ago(STALE_MS + 60_000) }).where(eq(actionSteps.actionId, child!.id));
    expect(await runScanChild(deps(), child!.id)).toEqual({ more: false });
    expect((await stepsOf(child!.id))[0]).toMatchObject({ status: 'success', attempts: 2 });
  });

  describe('sweepStaleScans', () => {
    const setup = async (stale = true) => {
      const t = await mk({ groupsOf: ['main'] });
      const id = await startScan(db, scanCreator(db, async () => {}), t.camp, { messageLimit: 0 });
      const [child] = await childrenOf(id);
      if (stale) await db.update(actions).set({ updatedAt: ago(STALE_MS + 60_000) }).where(eq(actions.id, child!.id));
      return { t, id, child: child! };
    };

    it('devolve filho em fila ou em andamento sem atividade; o worker reenfileira e a análise termina', async () => {
      const queued = await setup();
      const running = await setup();
      await db.update(actions).set({ status: 'processing' }).where(eq(actions.id, running.child.id));
      await db
        .update(actionSteps)
        .set({ status: 'processing', attempts: 1, updatedAt: ago(STALE_MS + 60_000) })
        .where(eq(actionSteps.actionId, running.child.id));
      const got = await sweepStaleScans(db);
      expect(got).toEqual(expect.arrayContaining([queued.child.id, running.child.id]));
      for (const c of [queued, running]) {
        expect(await runScanChild(deps(), c.child.id)).toEqual({ more: false });
        expect(await rowOf(c.id)).toMatchObject({ status: 'success' });
      }
      expect(await sweepStaleScans(db)).not.toEqual(expect.arrayContaining([queued.child.id]));
    });

    it('filho com atividade recente não é devolvido; `olderThanMs` muda o limite', async () => {
      const fresh = await setup(false);
      expect(await sweepStaleScans(db)).not.toContain(fresh.child.id);
      await new Promise((r) => setTimeout(r, 30));
      expect(await sweepStaleScans(db, { olderThanMs: 10 })).toContain(fresh.child.id);
    });

    it('pai cancelado ou concluído: o filho nunca é devolvido', async () => {
      const canceled = await setup();
      const finished = await setup();
      const open = await setup();
      // pai cancelado com o filho ainda "na fila" (cancelamento parcial) e pai concluído com filho esquecido
      await db.update(actions).set({ status: 'canceled' }).where(eq(actions.id, canceled.id));
      await db.update(actions).set({ status: 'success' }).where(eq(actions.id, finished.id));
      const got = await sweepStaleScans(db);
      expect(got).toContain(open.child.id);
      expect(got).not.toContain(canceled.child.id);
      expect(got).not.toContain(finished.child.id);
    });

    it('filho já terminado e a própria análise (pai) não são devolvidos', async () => {
      const done = await setup();
      await db.update(actions).set({ status: 'success' }).where(eq(actions.id, done.child.id));
      const got = await sweepStaleScans(db);
      expect(got).not.toContain(done.child.id);
      expect(got).not.toContain(done.id);
    });
  });

  it('fila falha ao enfileirar: a análise é cancelada com aviso em português e não sobra análise fantasma', async () => {
    const t = await mk({ groupsOf: ['main', 'main2'] });
    const queued: string[] = [];
    const create = scanCreator(db, async (c) => {
      if (queued.length) throw new Error('ECONNREFUSED redis');
      queued.push(c);
    });
    await expect(startScan(db, create, t.camp, { messageLimit: 0 })).rejects.toThrow(/não foi possível enfileirar a análise/);
    expect(await activeScan(db, t.camp)).toBeNull();
    const [view] = await listScans(db, { campaignId: t.camp });
    expect(view).toMatchObject({ status: 'canceled', active: false });
    const kids = await childrenOf(view!.id);
    expect(kids.every((k) => k.status === 'canceled')).toBe(true);
    const steps = (await Promise.all(kids.map((k) => stepsOf(k.id)))).flat();
    expect(steps.every((s) => s.status === 'skipped' && /fila indisponível/.test(s.error ?? ''))).toBe(true);
    // o filho que chegou a ser enfileirado não processa nada
    expect(await runScanChild(deps(), queued[0]!)).toEqual({ more: false });
    expect((await stepsOf(queued[0]!))[0]!.status).toBe('skipped');
    // e a campanha pode começar outra análise
    await expect(startScan(db, scanCreator(db, async () => {}), t.camp, { messageLimit: 0 })).resolves.toBeTruthy();
  });

  it('cancelScan fecha pai, filhos e passos pendentes; runScanChild não processa mais', async () => {
    const t = await mk({ groupsOf: ['main', 'main2'] });
    const id = await startScan(db, scanCreator(db, async () => {}), t.camp, { messageLimit: 0 });
    const kids = await childrenOf(id);
    // o filho da conta main termina antes do cancelamento
    expect(await runScanChild(deps(), kids.find((k) => k.waAccountId === t.acc.main)!.id)).toEqual({ more: false });
    await cancelScan(db, id);
    const p = await rowOf(id);
    expect(p).toMatchObject({ status: 'canceled', total: 2, processed: 2, success: 1, skipped: 1 });
    expect(p.finishedAt).not.toBeNull();
    const after = await childrenOf(id);
    const other = after.find((k) => k.waAccountId === t.acc.main2)!;
    expect(other).toMatchObject({ status: 'canceled', skipped: 1 });
    expect((await stepsOf(other.id))[0]).toMatchObject({ status: 'skipped', error: 'canceled' });
    // o filho que já tinha terminado continua success
    expect(after.find((k) => k.waAccountId === t.acc.main)!.status).toBe('success');
    expect(await runScanChild(deps(), other.id)).toEqual({ more: false });
    expect((await stepsOf(other.id))[0]!.status).toBe('skipped');
    expect(await activeScan(db, t.camp)).toBeNull();
    await cancelScan(db, id); // idempotente
    expect((await rowOf(id)).status).toBe('canceled');
  });

  it('cancelado no meio: runScanChild para antes do próximo grupo', async () => {
    const t = await mk({ groupsOf: ['main', 'main'] });
    const id = await startScan(db, scanCreator(db, async () => {}), t.camp, { messageLimit: 0 });
    const [child] = await childrenOf(id);
    expect(await runScanChild(deps(), child!.id)).toEqual({ more: true });
    await cancelScan(db, id);
    expect(await runScanChild(deps(), child!.id)).toEqual({ more: false });
    expect((await stepsOf(child!.id)).map((s) => s.status).sort()).toEqual(['skipped', 'success']);
    expect((await rowOf(id)).status).toBe('canceled');
  });

  it('filho inexistente: nada a fazer', async () => {
    expect(await runScanChild(deps(), '00000000-0000-4000-8000-000000000000')).toEqual({ more: false });
  });
});
