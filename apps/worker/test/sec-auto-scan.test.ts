import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { actions } from '@mag/db/schema';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import { FakeEngine } from '@mag/wa-engine/fake';
import { createSchedulerProcessor, registerSchedules } from '../src/processors/scheduler';
import { seedCampaign } from './helpers';

/** Vigia automática: tarefa diária na fila `scheduler`; cria a análise `security-scan` e enfileira os filhos. */
describe('tarefa sec.auto-scan: agendamento', () => {
  it('agenda uma vez por dia, às 03h07, no fuso informado', async () => {
    const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
    await registerSchedules(queue as never, 'America/Sao_Paulo');
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'sec.auto-scan',
      { pattern: '7 3 * * *', tz: 'America/Sao_Paulo' },
      { name: 'sec.auto-scan', data: { task: 'sec.auto-scan' } },
    );
  });
});

describe.skipIf(!PG_URL)('tarefa sec.auto-scan: processor (Postgres real)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  const engine = new FakeEngine();
  beforeAll(async () => {
    ({ db, drop } = await freshDb());
  });
  afterAll(async () => drop?.());

  it('cria a análise da campanha com a caixa ligada, enfileira o filho e não duplica', async () => {
    const on = { enabled: true, impersonation: 'auto', impersonationAutoScan: true };
    const ligada = await seedCampaign(db, engine, 2, on);
    const desligada = await seedCampaign(db, engine, 1);
    const queued: string[] = [];
    const run = createSchedulerProcessor({ db, enqueue: async (c) => void queued.push(c), log: () => {} });

    const r = await run({ data: { task: 'sec.auto-scan' } } as never);
    expect(r).toMatchObject({ started: [ligada.camp], skipped: [], failed: [] });
    expect(queued).toHaveLength(1);
    const [child] = await db.select().from(actions).where(eq(actions.id, queued[0]!));
    expect(child).toMatchObject({ type: 'security-scan', campaignId: ligada.camp, total: 2 });
    expect(await db.select().from(actions).where(eq(actions.campaignId, desligada.camp))).toHaveLength(0);

    // análise ainda em andamento: a rodada seguinte pula
    expect(await run({ data: { task: 'sec.auto-scan' } } as never)).toMatchObject({ started: [], skipped: [ligada.camp] });
    expect(queued).toHaveLength(1);
  });

  it('tarefa desconhecida é ignorada', async () => {
    const run = createSchedulerProcessor({ db, enqueue: async () => {}, log: () => {} });
    expect(await run({ data: { task: 'outra' } } as never)).toEqual({ skipped: true, task: 'outra' });
  });
});
