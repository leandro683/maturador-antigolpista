import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@mag/db';
import type { CsvEntry } from './csv';
import { normalizeEntry, type EntryKind } from './normalize';
import { admins, lists, numbers, type AdminRow, type ListRow, type NumberRow } from './tables';

/** Blacklists + números administrativos. Server-only. */

/** Lista global onde caem os bloqueios automáticos (anti-hacker/anti-spam). */
export const DEFAULT_LIST_NAME = 'Números bloqueados';

const listInputSchema = z.object({
  name: z.string().trim().min(1, 'nome obrigatório').max(80),
  campaignIds: z.array(z.uuid()).default([]),
  disabled: z.boolean().default(false),
});
export type ListInput = z.input<typeof listInputSchema>;

export async function listLists(db: Db): Promise<(ListRow & { count: number })[]> {
  const rows = await db
    .select({
      id: lists.id,
      name: lists.name,
      campaignIds: lists.campaignIds,
      disabled: lists.disabled,
      createdAt: lists.createdAt,
      count: count(numbers.id),
    })
    .from(lists)
    .leftJoin(numbers, eq(numbers.blacklistId, lists.id))
    .groupBy(lists.id)
    .orderBy(asc(lists.name));
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}

export async function createList(db: Db, input: ListInput): Promise<ListRow> {
  const [row] = await db.insert(lists).values(listInputSchema.parse(input)).returning();
  return row!;
}

export async function updateList(db: Db, id: string, patch: Partial<ListInput>): Promise<void> {
  const data = listInputSchema.partial().parse(patch);
  await db.update(lists).set(data).where(eq(lists.id, id));
}

/** Remove a lista e seus números (FK cascade). */
export async function deleteList(db: Db, id: string): Promise<void> {
  await db.delete(lists).where(eq(lists.id, id));
}

export async function ensureDefaultList(db: Db): Promise<ListRow> {
  const [found] = await db.select().from(lists).where(eq(lists.name, DEFAULT_LIST_NAME)).limit(1);
  return found ?? createList(db, { name: DEFAULT_LIST_NAME });
}

export type ListNumbersFilter = { blacklistId?: string; search?: string; page?: number; pageSize?: number };

export async function listNumbers(
  db: Db,
  f: ListNumbersFilter = {},
): Promise<{ rows: NumberRow[]; total: number }> {
  const where: SQL[] = [];
  if (f.blacklistId) where.push(eq(numbers.blacklistId, f.blacklistId));
  const q = f.search?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const digits = q.replace(/\D/g, '');
    where.push(
      or(
        ilike(numbers.name, like),
        ...(digits ? [ilike(numbers.number, `%${digits}%`), ilike(numbers.lid, `%${digits}%`)] : []),
      )!,
    );
  }
  const cond = where.length ? and(...where) : undefined;
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const rows = await db
    .select()
    .from(numbers)
    .where(cond)
    .orderBy(desc(numbers.createdAt), asc(numbers.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [t] = await db.select({ n: count() }).from(numbers).where(cond);
  return { rows, total: Number(t?.n ?? 0) };
}

/** Adição manual. Já existente na lista = no-op (retorna a linha atual). */
export async function addNumber(
  db: Db,
  blacklistId: string,
  input: { value: string; name?: string | null; kind?: EntryKind },
  source: NumberRow['source'] = 'manual',
): Promise<NumberRow> {
  const key = normalizeEntry(input.value, input.kind ?? 'auto');
  if (!key) throw new Error(input.kind === 'lid' ? 'LID inválido' : 'número inválido');
  const name = input.name?.trim() || null;
  const [row] = await db
    .insert(numbers)
    .values({ blacklistId, number: key.number ?? null, lid: key.lid ?? null, name, source })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [cur] = await db
    .select()
    .from(numbers)
    .where(
      and(
        eq(numbers.blacklistId, blacklistId),
        key.lid ? eq(numbers.lid, key.lid) : eq(numbers.number, key.number!),
      ),
    );
  return cur!;
}

/** Importação em lote (CSV já parseado). Duplicados na lista são ignorados. */
export async function importNumbers(
  db: Db,
  blacklistId: string,
  entries: CsvEntry[],
  source: NumberRow['source'] = 'csv',
): Promise<{ inserted: number; skipped: number }> {
  if (!entries.length) return { inserted: 0, skipped: 0 };
  let inserted = 0;
  for (let i = 0; i < entries.length; i += 500) {
    const chunk = entries.slice(i, i + 500);
    const rows = await db
      .insert(numbers)
      .values(
        chunk.map((e) => ({
          blacklistId,
          number: e.number ?? null,
          lid: e.lid ?? null,
          name: e.name ?? null,
          source,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: numbers.id });
    inserted += rows.length;
  }
  return { inserted, skipped: entries.length - inserted };
}

export async function removeNumbers(db: Db, ids: string[]): Promise<void> {
  if (ids.length) await db.delete(numbers).where(inArray(numbers.id, ids));
}

/** Bloqueio automático (anti-golpista): vai p/ a lista global com origem `anti_hacker`. */
export async function addAutoBlocked(db: Db, phoneOrLid: string, name: string): Promise<NumberRow> {
  const list = await ensureDefaultList(db);
  return addNumber(db, list.id, { value: phoneOrLid, name }, 'anti_hacker');
}

// ---- números administrativos (nunca removidos/bloqueados) ----

export async function listAdminNumbers(db: Db, search?: string): Promise<AdminRow[]> {
  const q = search?.trim();
  const like = q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : null;
  return db
    .select()
    .from(admins)
    .where(like ? or(ilike(admins.label, like), ilike(admins.number, like)) : undefined)
    .orderBy(asc(sql`coalesce(${admins.label}, ${admins.number})`));
}

export async function addAdminNumber(
  db: Db,
  input: { value: string; label?: string | null },
): Promise<AdminRow> {
  const key = normalizeEntry(input.value);
  if (!key?.number) throw new Error('número inválido');
  const label = input.label?.trim() || null;
  const [row] = await db
    .insert(admins)
    .values({ number: key.number, label })
    .onConflictDoUpdate({ target: admins.number, set: { label } })
    .returning();
  return row!;
}

export async function removeAdminNumber(db: Db, id: string): Promise<void> {
  await db.delete(admins).where(eq(admins.id, id));
}
