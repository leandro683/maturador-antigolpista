import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { actions } from '@mag/db/schema';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import { DrizzleSecRepo, scanCreator, startScan } from '@mag/module-security';
import { FakeEngine } from '@mag/wa-engine/fake';
import { SCAN_GAP_MAX_MS, SCAN_GAP_MIN_MS, createSecScanProcessor } from '../src/processors/sec-scan';
import { seedCampaign } from './helpers';

describe.skipIf(!PG_URL)('worker sec-scan (Postgres real)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  const engine = new FakeEngine();
  beforeAll(async () => {
    ({ db, drop } = await freshDb());
  });
  afterAll(async () => drop?.());

  const setup = (rnd?: () => number) => {
    const add = vi.fn(async () => undefined);
    const run = createSecScanProcessor({
      db,
      engine,
      scan: { repo: new DrizzleSecRepo(db), sleep: async () => {} },
      queue: { add } as never,
      rnd,
    });
    return { add, run: (childId: string) => run({ data: { childId } } as never) };
  };

  it('reenfileira o filho com atraso de 40–60 s enquanto há grupo, e para quando acaba', async () => {
    const t = await seedCampaign(db, engine, 3);
    const first: string[] = [];
    const scanId = await startScan(db, scanCreator(db, async (c) => void first.push(c)), t.camp, { messageLimit: 10 });
    expect(first).toHaveLength(1);
    const childId = first[0]!;

    const w = setup(() => 0.5);
    const results = [await w.run(childId), await w.run(childId), await w.run(childId)];
    expect(results.map((r) => r.more)).toEqual([true, true, false]);
    expect(w.add).toHaveBeenCalledTimes(2);
    expect(w.add).toHaveBeenNthCalledWith(1, 'scan', { childId }, { delay: 50_000 });
    // nada sobra: outra chamada não faz nada nem reenfileira
    expect((await w.run(childId)).more).toBe(false);
    expect(w.add).toHaveBeenCalledTimes(2);
    const [parent] = await db.select().from(actions).where(eq(actions.id, scanId));
    expect(parent).toMatchObject({ status: 'success', processed: 3 });
  });

  it('o atraso fica sempre entre 40 e 60 s', async () => {
    expect([SCAN_GAP_MIN_MS, SCAN_GAP_MAX_MS]).toEqual([40_000, 60_000]);
    for (const [rnd, ms] of [[0, 40_000], [0.999999, 59_999]] as const) {
      const t = await seedCampaign(db, engine, 2);
      const ids: string[] = [];
      await startScan(db, scanCreator(db, async (c) => void ids.push(c)), t.camp, { messageLimit: 10 });
      const w = setup(() => rnd);
      expect((await w.run(ids[0]!)).more).toBe(true);
      expect(w.add).toHaveBeenCalledWith('scan', { childId: ids[0] }, { delay: ms });
    }
  });
});
