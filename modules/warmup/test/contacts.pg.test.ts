import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { Db } from '@mag/db';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import { addChip, candidatePairs, confirmChipContacts, pageData, paidCostToday, startConversation, endConversation, syncPairs } from '../src/repo';

describe.skipIf(!PG_URL)('maturador: contatos por parceiro, dia do teto e backfill', () => {
  let db: Db;
  let sql: postgres.Sql;
  let drop: () => Promise<void>;
  const ids: string[] = [];
  const pair = (x: string, y: string) => [x, y].sort().join('|');
  const keys = async () => (await candidatePairs(db, new Date())).map((p) => pair(p.a, p.b)).sort();

  beforeAll(async () => {
    ({ db, sql, drop } = await freshDb());
    for (const i of [1, 2, 3]) {
      const [r] = await sql`INSERT INTO mag.wa_accounts (name, session_name, status, jid)
        VALUES (${'ct' + i}, ${'ctsess' + i}, 'connected', ${`55119999900${'0' + i}@c.us`}) RETURNING id`;
      ids.push(String(r!.id));
    }
  });
  afterAll(async () => drop?.());

  it('chip novo exige re-confirmação: A–C só vira candidato quando A salva de novo; A–B segue valendo', async () => {
    const [a, b, c] = ids as [string, string, string];
    await addChip(db, a);
    await addChip(db, b);
    await sql`UPDATE mag.warmup_chips SET created_at = now() - interval '2 hours'`;
    await sql`UPDATE mag.warmup_chips SET contacts_confirmed_at = now() - interval '1 hour'`;
    await syncPairs(db);
    expect(await keys()).toEqual([pair(a, b)]);

    await addChip(db, c); // created_at = agora, depois da confirmação de A e B
    await syncPairs(db);
    expect(await keys()).toEqual([pair(a, b)]);
    let d = await pageData(db, '2026-11-10');
    expect(d.chips.find((x) => x.accountId === a)).toMatchObject({ contactsConfirmed: false, hadConfirmed: true });
    expect(d.chips.find((x) => x.accountId === c)).toMatchObject({ contactsConfirmed: false, hadConfirmed: false });
    expect(d.pairsReady).toBe(1);

    await confirmChipContacts(db, a);
    expect(await keys()).toEqual([pair(a, b)]); // C ainda não salvou o número de A e B
    await confirmChipContacts(db, c);
    expect(await keys()).toEqual([pair(a, b), pair(a, c)].sort());
    await confirmChipContacts(db, b);
    expect((await keys()).sort()).toEqual([pair(a, b), pair(a, c), pair(b, c)].sort());
    d = await pageData(db, '2026-11-10');
    expect(d.chips.every((x) => x.contactsConfirmed)).toBe(true);
    expect(d.pairsReady).toBe(3);
  });

  it('paidCostToday vale o dia UTC: 22:00 de Brasília (01:00 UTC) já é o dia seguinte', async () => {
    const [pr] = await sql`SELECT id FROM mag.warmup_pairs LIMIT 1`;
    const at = async (iso: string, usd: number) => {
      const c = await startConversation(db, String(pr!.id), 'queue', 2, [], usd, { themeId: null, model: 'p', paid: true });
      await endConversation(db, c!.id, 'done', null);
      await sql`UPDATE mag.warmup_conversations SET started_at = ${iso}::timestamptz WHERE id = ${c!.id}`;
    };
    await at('2026-11-10T23:00:00Z', 0.1); // 20:00 de Brasília, dia UTC 10
    await at('2026-11-11T01:00:00Z', 0.3); // 22:00 de Brasília do dia 10, mas dia UTC 11
    expect(await paidCostToday(db, new Date('2026-11-10T12:00:00Z'))).toBeCloseTo(0.1);
    expect(await paidCostToday(db, new Date('2026-11-11T00:30:00Z'))).toBeCloseTo(0.3); // 21:30 de Brasília
    expect(await paidCostToday(db, new Date('2026-11-11T02:00:00Z'))).toBeCloseTo(0.3); // 23:00 de Brasília
  });

  it('backfill dos contatos: só confirma o chip cujos pares confirmados cobrem todos os outros ativos', async () => {
    // O backfill dos contatos não está nas migrations daqui (schema único); o comando fica copiado aqui para o teste.
    const stmt = `UPDATE mag.warmup_chips c SET contacts_confirmed_at = now()
      WHERE c.contacts_confirmed_at IS NULL
        AND EXISTS (SELECT 1 FROM mag.warmup_pairs p
          WHERE p.contacts_confirmed_at IS NOT NULL AND c.account_id IN (p.account_a, p.account_b))
        AND NOT EXISTS (SELECT 1 FROM mag.warmup_chips o
          WHERE o.account_id <> c.account_id AND NOT EXISTS (
            SELECT 1 FROM mag.warmup_pairs p
            WHERE p.contacts_confirmed_at IS NOT NULL
              AND ((p.account_a = c.account_id AND p.account_b = o.account_id)
                OR (p.account_b = c.account_id AND p.account_a = o.account_id))));`;
    const [a, b, c] = [...ids].sort() as [string, string, string];
    await sql`UPDATE mag.warmup_chips SET contacts_confirmed_at = NULL, active = true`;
    await sql`UPDATE mag.warmup_pairs SET contacts_confirmed_at = NULL`;
    await sql`UPDATE mag.warmup_pairs SET contacts_confirmed_at = now()
      WHERE (account_a, account_b) IN ((${a}, ${b}), (${a}, ${c}))`; // b–c não confirmado
    await sql.unsafe(stmt);
    const rows = await sql`SELECT account_id, contacts_confirmed_at FROM mag.warmup_chips`;
    const ok = (id: string) => rows.find((r) => r.account_id === id)!.contacts_confirmed_at != null;
    expect(ok(a)).toBe(true); // tem par confirmado com b e com c
    expect(ok(b)).toBe(false); // falta b–c
    expect(ok(c)).toBe(false);
  });
});
