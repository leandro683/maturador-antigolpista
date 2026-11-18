import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@mag/db';
import { campaigns } from '@mag/db/schema';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import { runAutoScan } from '../src/auto-scan';

/** Vigia automática no Postgres real: campanha arquivada fica de fora; só 1 análise por campanha. */
describe.skipIf(!PG_URL)('vigia automática no Postgres', () => {
  let db: Db;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
  });
  afterAll(async () => {
    await drop();
  });

  it('ignora arquivada e não duplica análise em andamento', async () => {
    const on = { enabled: true, impersonation: 'auto', impersonationAutoScan: true };
    const [a] = await db.insert(campaigns).values({ name: 'Viva', slug: 'viva', antiHacker: on }).returning();
    await db.insert(campaigns).values({ name: 'Velha', slug: 'velha', archived: true, antiHacker: on });
    await db.insert(campaigns).values({ name: 'Sem caixa', slug: 'sem-caixa', antiHacker: { ...on, impersonationAutoScan: false } });
    const create = async () => {
      const { actions } = await import('@mag/db/schema');
      const [row] = await db
        .insert(actions)
        .values({ type: 'security-scan', campaignId: a!.id, payload: {}, options: {}, status: 'queued' })
        .returning({ id: actions.id });
      return row!;
    };
    const first = await runAutoScan({ db, create });
    expect(first.started).toEqual([a!.id]);
    const second = await runAutoScan({ db, create });
    expect(second).toEqual({ started: [], skipped: [a!.id], failed: [] });
  });
});
