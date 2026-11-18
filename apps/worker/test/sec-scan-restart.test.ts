import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { actions, actionSteps } from '@mag/db/schema';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import { DrizzleSecRepo, runScanChild, scanCreator, startScan, STALE_MS, sweepStaleScans } from '@mag/module-security';
import { FakeEngine } from '@mag/wa-engine/fake';
import { createScanQueue, createSecScanProcessor, resumeStaleScans, scanQueued } from '../src/processors/sec-scan';
import {
  createSchedulerProcessor,
  registerSchedules,
  SEC_RESUME_EVERY_MS,
  SEC_RESUME_TASK,
} from '../src/processors/scheduler';
import { seedCampaign } from './helpers';

describe('análise parada: retomada por agenda própria', () => {
  it('além da tarefa diária, há uma tarefa repetida a cada poucos minutos que retoma análises paradas', async () => {
    const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
    await registerSchedules(queue as never, 'America/Sao_Paulo');
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      SEC_RESUME_TASK,
      { every: SEC_RESUME_EVERY_MS },
      { name: SEC_RESUME_TASK, data: { task: SEC_RESUME_TASK } },
    );
    expect(SEC_RESUME_EVERY_MS).toBeLessThanOrEqual(5 * 60_000);
    expect(STALE_MS).toBeLessThanOrEqual(10 * 60_000);
  });
});

describe('scanQueued: o filho tem job na fila de verdade (Redis)', () => {
  it('vê o job adiado do filho e não confunde com outro', async () => {
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6399', { maxRetriesPerRequest: null });
    const queue = createScanQueue(connection, `mag-test-${randomUUID()}`); // fila própria: nenhum worker real a enxerga
    try {
      const j = await queue.add('scan', { childId: 'filho-na-fila' }, { delay: 3_600_000 });
      const queued = scanQueued(queue);
      expect(await queued('filho-na-fila')).toBe(true);
      expect(await queued('filho-fora-da-fila')).toBe(false);
      await j.remove();
      expect(await queued('filho-na-fila')).toBe(false);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      connection.disconnect();
    }
  });
});

describe.skipIf(!PG_URL)('worker reiniciado no meio de um grupo (Postgres real)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  const engine = new FakeEngine();
  const ago = (ms: number) => new Date(Date.now() - ms);
  beforeAll(async () => {
    ({ db, drop } = await freshDb());
  });
  afterAll(async () => drop?.());
  // cada teste parte sem análise nenhuma
  beforeEach(async () => {
    await db.delete(actionSteps);
    await db.delete(actions);
  });

  const scanDeps = () => ({ db, engine, scan: { repo: new DrizzleSecRepo(db), sleep: async () => {} } });
  const stepsOf = (actionId: string) => db.select().from(actionSteps).where(eq(actionSteps.actionId, actionId));
  const rowOf = async (id: string) => (await db.select().from(actions).where(eq(actions.id, id)))[0]!;

  it('passo pego, worker morreu, o job volta e desiste; passado o prazo a tarefa repetida retoma e a análise termina sem repetir grupo', async () => {
    const t = await seedCampaign(db, engine, 3);
    const queue: string[] = [];
    const enqueue = async (id: string) => void queue.push(id);
    const parentId = await startScan(db, scanCreator(db, enqueue), t.camp, { messageLimit: 0 });
    const childId = queue[0]!;
    const proc = createSecScanProcessor({
      ...scanDeps(),
      queue: { add: async (_n: string, d: { childId: string }) => void queue.push(d.childId) } as never,
      rnd: () => 0,
    });
    const job = { data: { childId } } as never;
    const consulted: string[] = [];
    const real = engine.getGroup.bind(engine);
    const spy = vi.spyOn(engine, 'getGroup').mockImplementation(async (s, gid) => (consulted.push(gid), real(s, gid)));
    try {
      // o worker pegou o 1º grupo e morreu antes de gravar qualquer coisa
      const [first] = (await stepsOf(childId)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      await db.update(actionSteps).set({ status: 'processing', attempts: 1, updatedAt: new Date() }).where(eq(actionSteps.id, first!.id));
      await db.update(actions).set({ status: 'processing', updatedAt: new Date() }).where(eq(actions.id, childId));

      // BullMQ devolve o job: o passo ainda parece vivo, então o job desiste sem fazer nada e sem reenfileirar
      queue.length = 0;
      expect(await proc(job)).toEqual({ more: false });
      expect(queue).toEqual([]);
      expect(consulted).toEqual([]);
      expect(await sweepStaleScans(db)).toEqual([]);

      // passa o prazo: a tarefa repetida (não a diária) devolve o filho à fila
      await db.update(actionSteps).set({ updatedAt: ago(STALE_MS + 60_000) }).where(eq(actionSteps.id, first!.id));
      await db.update(actions).set({ updatedAt: ago(STALE_MS + 60_000) }).where(eq(actions.id, childId));
      const run = createSchedulerProcessor({ db, enqueue, log: () => {} });
      expect(await run({ data: { task: SEC_RESUME_TASK } } as never)).toMatchObject({ resumed: 1 });
      expect(queue).toEqual([childId]);

      // a corrente completa: um grupo por job
      let guard = 0;
      while (queue.length && guard++ < 10) await proc({ data: { childId: queue.shift()! } } as never);
      expect(await rowOf(childId)).toMatchObject({ status: 'success', processed: 3, success: 3 });
      expect(await rowOf(parentId)).toMatchObject({ status: 'success' });
      // cada grupo foi consultado uma vez só; o passo que o worker morto pegou foi refeito (2ª tentativa)
      expect([...consulted].sort()).toEqual(t.gs.map((g) => g.gid).sort());
      expect((await stepsOf(childId)).map((s) => s.attempts).sort()).toEqual([1, 1, 2]);
    } finally {
      spy.mockRestore();
    }
  });

  it('tarefa repetida não duplica filho que ainda tem job na fila (análise esperando vez, não parada)', async () => {
    const t = await seedCampaign(db, engine, 1);
    const ids: string[] = [];
    await startScan(db, scanCreator(db, async (c) => void ids.push(c)), t.camp, { messageLimit: 0 });
    await db.update(actions).set({ updatedAt: ago(STALE_MS + 60_000) }).where(eq(actions.id, ids[0]!));
    const queued: string[] = [];
    const isQueued = async (c: string) => c === ids[0];
    expect(await resumeStaleScans({ db, enqueue: async (c) => void queued.push(c), isQueued, log: () => {} })).toBe(0);
    expect(queued).toEqual([]);
    expect(await resumeStaleScans({ db, enqueue: async (c) => void queued.push(c), isQueued: async () => false, log: () => {} })).toBe(1);
    expect(queued).toEqual([ids[0]]);
  });

  it('passo longo e vivo: o batimento mantém passo e filho recentes, então ninguém o refaz', async () => {
    const t = await seedCampaign(db, engine, 1);
    const ids: string[] = [];
    await startScan(db, scanCreator(db, async (c) => void ids.push(c)), t.camp, { messageLimit: 0 });
    const childId = ids[0]!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = engine.getGroup.bind(engine);
    const spy = vi.spyOn(engine, 'getGroup').mockImplementationOnce(async (s, gid) => {
      await gate;
      return real(s, gid);
    });
    try {
      const running = runScanChild({ ...scanDeps(), heartbeatMs: 20 }, childId);
      await vi.waitFor(async () => expect((await stepsOf(childId))[0]!.status).toBe('processing'), { timeout: 20_000, interval: 50 });
      // simula 1 hora de passo: a última atividade gravada ficou velha, e o batimento tem que trazê-la de volta
      await db.update(actionSteps).set({ updatedAt: ago(60 * 60_000) }).where(eq(actionSteps.actionId, childId));
      await db.update(actions).set({ updatedAt: ago(60 * 60_000) }).where(eq(actions.id, childId));
      await vi.waitFor(async () => expect(await sweepStaleScans(db)).not.toContain(childId), { timeout: 20_000, interval: 50 });
      // outro trabalhador que chegue agora vê o passo vivo e desiste
      expect(await runScanChild(scanDeps(), childId)).toEqual({ more: false });
      release();
      expect(await running).toEqual({ more: false });
      expect((await stepsOf(childId))[0]).toMatchObject({ status: 'success', attempts: 1 });
    } finally {
      release();
      spy.mockRestore();
    }
  });
});
