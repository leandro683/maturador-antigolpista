import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { actions, actionSteps } from '@mag/db/schema';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import type * as Security from '@mag/module-security';
import { FakeEngine } from '@mag/wa-engine/fake';
import { seedCampaign } from './helpers';

// `runScanChild` falso só neste arquivo: aqui o que importa é o que o processor faz com o resultado ou o erro dele.
const runScanChild = vi.fn();
vi.mock('@mag/module-security', async (orig) => ({ ...(await orig<typeof Security>()), runScanChild }));

const { SCAN_JOB_OPTIONS, createScanQueue, createSecScanProcessor, resumeStaleScans, scanEnqueuer } = await import(
  '../src/processors/sec-scan'
);
const { createSchedulerProcessor } = await import('../src/processors/scheduler');
const { scanCreator, startScan, sweepStaleScans, STALE_MS } = await import('@mag/module-security');

const job = (childId: string) => ({ data: { childId } }) as never;

describe('processor sec-scan: erro e reenfileiramento', () => {
  const add = vi.fn(async () => undefined);
  const proc = () =>
    createSecScanProcessor({ db: {} as never, engine: {} as never, scan: {} as never, queue: { add } as never, rnd: () => 0 });
  beforeEach(() => {
    add.mockClear();
    runScanChild.mockReset();
  });

  it('erro do passo sobe para o BullMQ (que tenta de novo) e não reenfileira', async () => {
    runScanChild.mockRejectedValue(new Error('banco caiu'));
    await expect(proc()(job('c1'))).rejects.toThrow('banco caiu');
    expect(add).not.toHaveBeenCalled();
  });

  it('só reenfileira quando more: true; more: false (acabou, cancelada ou outro trabalhador) encerra a corrente', async () => {
    runScanChild.mockResolvedValueOnce({ more: true }).mockResolvedValueOnce({ more: false });
    await proc()(job('c1'));
    expect(add).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith('scan', { childId: 'c1' }, { delay: 40_000 });
    await proc()(job('c1'));
    expect(add).toHaveBeenCalledOnce();
  });
});

describe('fila sec-scan: tentativas', () => {
  it('jobs nascem com 5 tentativas e espera exponencial', async () => {
    expect(SCAN_JOB_OPTIONS).toEqual({ attempts: 5, backoff: { type: 'exponential', delay: 5000 } });
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6399', { maxRetriesPerRequest: null });
    const queue = createScanQueue(connection, `mag-test-${randomUUID()}`); // fila própria: nenhum worker real a enxerga
    try {
      const j = await queue.add('scan', { childId: 'teste-tentativas' }, { delay: 3_600_000 });
      expect(j.opts).toMatchObject({ attempts: 5, backoff: { type: 'exponential', delay: 5000 } });
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      connection.disconnect();
    }
  });
});

describe('scanEnqueuer', () => {
  it('fila que falha → o erro sobe (não é engolido)', async () => {
    const enqueue = scanEnqueuer({ add: vi.fn(async () => Promise.reject(new Error('redis fora'))) } as never);
    await expect(enqueue('c1')).rejects.toThrow('redis fora');
  });
});

describe.skipIf(!PG_URL)('análise parada e fila fora (Postgres real)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  const engine = new FakeEngine();
  beforeAll(async () => {
    ({ db, drop } = await freshDb());
  });
  afterAll(async () => drop?.());
  // cada teste parte sem análise nenhuma (as dos testes anteriores também ficariam "paradas")
  beforeEach(async () => {
    await db.delete(actionSteps);
    await db.delete(actions);
  });

  const old = new Date(Date.now() - STALE_MS - 60_000);

  it('fila fora ao criar a análise: ela é cancelada com mensagem em português (nada fica "em andamento")', async () => {
    const t = await seedCampaign(db, engine, 2);
    const enqueue = scanEnqueuer({ add: vi.fn(async () => Promise.reject(new Error('redis fora'))) } as never);
    await expect(startScan(db, scanCreator(db, enqueue), t.camp, { messageLimit: 10 })).rejects.toThrow(/cancelada/);
    const rows = await db.select().from(actions).where(eq(actions.campaignId, t.camp));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'canceled')).toBe(true);
  });

  it('resumeStaleScans reenfileira só o filho parado há mais de STALE_MS', async () => {
    const parado = await seedCampaign(db, engine, 1);
    const recente = await seedCampaign(db, engine, 1);
    const ids = { parado: [] as string[], recente: [] as string[] };
    await startScan(db, scanCreator(db, async (c) => void ids.parado.push(c)), parado.camp, { messageLimit: 10 });
    await startScan(db, scanCreator(db, async (c) => void ids.recente.push(c)), recente.camp, { messageLimit: 10 });
    await db.update(actions).set({ updatedAt: old }).where(eq(actions.id, ids.parado[0]!));

    expect(await sweepStaleScans(db)).toEqual([ids.parado[0]]);
    const queued: string[] = [];
    expect(await resumeStaleScans({ db, enqueue: async (c) => void queued.push(c), log: () => {} })).toBe(1);
    expect(queued).toEqual([ids.parado[0]]);
  });

  it('resumeStaleScans: fila que falha para um filho não impede os demais e é registrada', async () => {
    const a = await seedCampaign(db, engine, 1);
    const b = await seedCampaign(db, engine, 1);
    const made: string[] = [];
    await startScan(db, scanCreator(db, async (c) => void made.push(c)), a.camp, { messageLimit: 10 });
    await startScan(db, scanCreator(db, async (c) => void made.push(c)), b.camp, { messageLimit: 10 });
    await db.update(actions).set({ updatedAt: old }).where(eq(actions.id, made[0]!));
    await db.update(actions).set({ updatedAt: old }).where(eq(actions.id, made[1]!));
    const logs: string[] = [];
    const ok: string[] = [];
    const n = await resumeStaleScans({
      db,
      enqueue: async (c) => {
        if (c === made[0]) throw new Error('redis fora');
        ok.push(c);
      },
      log: (m) => void logs.push(m),
    });
    expect(n).toBe(1);
    expect(ok).toEqual([made[1]]);
    expect(logs.join('\n')).toContain(made[0]!);
  });

  it('a tarefa diária devolve à fila as análises paradas antes de criar as novas', async () => {
    const ligada = await seedCampaign(db, engine, 1, { enabled: true, impersonation: 'auto', impersonationAutoScan: true });
    const parada = await seedCampaign(db, engine, 1);
    const ids: string[] = [];
    await startScan(db, scanCreator(db, async (c) => void ids.push(c)), parada.camp, { messageLimit: 10 });
    await db.update(actions).set({ updatedAt: old }).where(eq(actions.id, ids[0]!));

    const queued: string[] = [];
    const run = createSchedulerProcessor({ db, enqueue: async (c) => void queued.push(c), log: () => {} });
    const r = await run({ data: { task: 'sec.auto-scan' } } as never);
    expect(r).toMatchObject({ resumed: 1, started: [ligada.camp] });
    expect(queued[0]).toBe(ids[0]); // a parada voltou primeiro
    expect(queued).toHaveLength(2);
  });

});
