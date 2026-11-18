import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { Db } from '@mag/db';
import { FREE_DEFAULT, PAID_DEFAULT } from '../src/models';
import { getSettings } from '../src/repo';
import { freshDb, PG_URL } from '@mag/db/test-pg';

describe.skipIf(!PG_URL)('migração do maturador', () => {
  let sql: postgres.Sql;
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, sql, drop } = await freshDb());
  });
  afterAll(async () => {
    await drop?.();
  });

  it('cria as 6 tabelas e a linha 1 de configuração com os padrões', async () => {
    const t = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'mag' AND table_name LIKE 'warmup_%'`;
    expect(t.map((r) => r.table_name).sort()).toEqual(['warmup_chips', 'warmup_conversations', 'warmup_messages', 'warmup_pairs', 'warmup_settings', 'warmup_themes']);
    const [s] = await sql`SELECT * FROM mag.warmup_settings`;
    if (!s) throw new Error("sem linha 1");
    expect(s).toMatchObject({ id: 1, enabled: false, mode: 'queue', model: 'openai/gpt-6-luna', gap_min_sec: 45, gap_max_sec: 180, typing_cps: 5, pause_min_min: 10, pause_max_min: 40, turns_min: 6, turns_max: 14, window_start: null, window_end: null });
    expect(Number(s.daily_cap_usd)).toBe(1);
  });

  it('semeia 16 temas e os padrões do v2', async () => {
    const t = await sql`SELECT name, avoid FROM mag.warmup_themes ORDER BY position`;
    expect(t).toHaveLength(16);
    expect(t.find((r) => r.name === 'Futebol brasileiro')?.avoid).toBe('a tragédia da Chapecoense');
    expect(await getSettings(db)).toMatchObject({ freeModels: FREE_DEFAULT, paidModels: PAID_DEFAULT, paidBackup: true, activeCap: 3, mode: 'queue', pausedUntil: null });
  });

  it('backfill: chip de par confirmado recebe contacts_confirmed_at', async () => {
    const ids: string[] = [];
    for (const i of [1, 2]) {
      const [r] = await sql`INSERT INTO mag.wa_accounts (name, session_name, status, jid) VALUES (${'bf' + i}, ${'bfsess' + i}, 'connected', ${`55119999900${'0' + i}@c.us`}) RETURNING id`;
      ids.push(String(r!.id));
    }
    ids.sort();
    for (const id of ids) await sql`INSERT INTO mag.warmup_chips (account_id) VALUES (${id})`;
    await sql`INSERT INTO mag.warmup_pairs (account_a, account_b, contacts_confirmed_at) VALUES (${ids[0]!}, ${ids[1]!}, now())`;
    await sql`UPDATE mag.warmup_chips c SET contacts_confirmed_at = now() WHERE contacts_confirmed_at IS NULL AND EXISTS
      (SELECT 1 FROM mag.warmup_pairs p WHERE p.contacts_confirmed_at IS NOT NULL AND c.account_id IN (p.account_a, p.account_b))`;
    const r = await sql`SELECT contacts_confirmed_at FROM mag.warmup_chips WHERE account_id = ${ids[0]!}`;
    expect(r[0]?.contacts_confirmed_at).not.toBeNull();
  });
});
