import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { Db } from '@mag/db';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import { lastConversationToday } from '../src/page-extra';

describe.skipIf(!PG_URL)('lastConversationToday', () => {
  let db: Db;
  let sql: postgres.Sql;
  let drop: () => Promise<void>;
  let pair = '';

  beforeAll(async () => {
    ({ db, sql, drop } = await freshDb());
    const ids: string[] = [];
    for (const i of [1, 2]) {
      const [r] = await sql`INSERT INTO mag.wa_accounts (name, session_name, status, jid, lid)
        VALUES (${'P' + i}, ${'psess' + i}, 'connected', ${`55119999900${'0' + i}@c.us`}, ${`10000000000000${i}@lid`}) RETURNING id`;
      ids.push(String(r!.id));
    }
    const [p] = await sql`INSERT INTO mag.warmup_pairs (account_a, account_b) VALUES (${[ids[0]!, ids[1]!].sort()[0]!}, ${[ids[0]!, ids[1]!].sort()[1]!}) RETURNING id`; // CHECK account_a < account_b
    pair = String(p!.id);
  });
  afterAll(async () => {
    await drop?.();
  });

  const conv = (model: string, paid: boolean, at: string, status = 'done') =>
    sql`INSERT INTO mag.warmup_conversations (pair_id, mode, turns_target, lines, status, model, paid, started_at)
      VALUES (${pair}, 'queue', 2, '[]'::jsonb, ${status}, ${model}, ${paid}, ${at}::timestamptz)`;

  it('sem conversa no dia = null', async () => {
    expect(await lastConversationToday(db, '2026-11-10')).toBeNull();
  });

  it('devolve a mais recente do dia de Brasília e ignora outros dias', async () => {
    await conv('gratis', false, '2026-11-10T12:00:00Z');
    await conv('pago', true, '2026-11-10T15:00:00Z');
    await conv('ontem', false, '2026-11-11T02:00:00Z'); // 23h do dia 10 em Brasília: ainda conta
    await conv('amanha', true, '2026-11-11T04:00:00Z'); // 01h do dia 11: fora
    expect(await lastConversationToday(db, '2026-11-10')).toEqual({ paid: false, model: 'ontem' });
    expect(await lastConversationToday(db, '2026-11-11')).toEqual({ paid: true, model: 'amanha' });
  });
});
