import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { campaigns, waAccounts } from '@mag/db/schema';
import type { CsvEntry } from '../../blacklist/csv';
import { normalizeEntry } from '../../blacklist/normalize';
import { identityOf, IdentitySet, lidJid, sameIdentity, type Identity } from './identity';
import { collaborators, verifications, type CollaboratorRow, type VerificationRow } from './tables';

/**
 * Verificação de colaboradores: telefones/LIDs oficiais por campanha + contas da campanha ("administradores
 * de contas associadas", automáticos). Consulta grava histórico (quem, quando, resultado) e alimenta contadores.
 * Colaborador verificado entra na allowlist do anti-hacker.
 */

export type Collaborator = Pick<CollaboratorRow, 'id' | 'number' | 'lid' | 'name' | 'source' | 'createdAt'>;

export async function listCollaborators(db: Db, campaignId: string): Promise<Collaborator[]> {
  return db
    .select({
      id: collaborators.id,
      number: collaborators.number,
      lid: collaborators.lid,
      name: collaborators.name,
      source: collaborators.source,
      createdAt: collaborators.createdAt,
    })
    .from(collaborators)
    .where(eq(collaborators.campaignId, campaignId))
    .orderBy(sql`coalesce(${collaborators.name}, ${collaborators.number}, ${collaborators.lid})`);
}

/** Contas da campanha (automáticas na lista). */
export async function accountCollaborators(db: Db, campaignId: string) {
  const [c] = await db
    .select({ ids: campaigns.accountIds })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!c?.ids?.length) return [];
  return db
    .select({ id: waAccounts.id, name: waAccounts.name, jid: waAccounts.jid, lid: waAccounts.lid })
    .from(waAccounts)
    .where(inArray(waAccounts.id, c.ids));
}

export async function addCollaborator(
  db: Db,
  campaignId: string,
  input: { value: string; name?: string | null; kind?: 'auto' | 'phone' | 'lid' },
): Promise<void> {
  const k = normalizeEntry(input.value, input.kind ?? 'auto');
  if (!k) throw new Error(input.kind === 'lid' ? 'LID inválido' : 'número inválido');
  await db
    .insert(collaborators)
    .values({ campaignId, number: k.number ?? null, lid: k.lid ?? null, name: input.name?.trim() || null })
    .onConflictDoNothing();
}

export async function importCollaborators(
  db: Db,
  campaignId: string,
  entries: CsvEntry[],
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  for (let i = 0; i < entries.length; i += 500) {
    const rows = await db
      .insert(collaborators)
      .values(
        entries.slice(i, i + 500).map((e) => ({
          campaignId,
          number: e.number ?? null,
          lid: e.lid ?? null,
          name: e.name ?? null,
          source: 'csv' as const,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: collaborators.id });
    inserted += rows.length;
  }
  return { inserted, skipped: entries.length - inserted };
}

export async function removeCollaborators(db: Db, campaignId: string, ids: string[]) {
  if (ids.length)
    await db
      .delete(collaborators)
      .where(and(eq(collaborators.campaignId, campaignId), inArray(collaborators.id, ids)));
}

export type VerifyResult = {
  valid: boolean;
  result: boolean;
  identity: Identity;
  match: { kind: 'collaborator' | 'account'; id: string; name: string | null } | null;
};

/** "Este número é colaborador?" — sempre grava histórico (número inválido também, com result=false). */
export async function verifyNumber(
  db: Db,
  campaignId: string,
  query: string,
  opts: { checkedBy?: string | null; channel?: 'painel' | 'publico' | 'api' } = {},
): Promise<VerifyResult> {
  const q = query.trim().slice(0, 60);
  const identity = identityOf(q);
  const valid = !!(identity.number || identity.lid);
  let match: VerifyResult['match'] = null;
  if (valid) {
    const set = new IdentitySet([identity]);
    const col = (await listCollaborators(db, campaignId)).find((c) =>
      set.has(identityOf(c.number, lidJid(c.lid))),
    );
    if (col) match = { kind: 'collaborator', id: col.id, name: col.name };
    else {
      const acc = (await accountCollaborators(db, campaignId)).find((a) =>
        sameIdentity(identity, identityOf(a.jid, lidJid(a.lid))),
      );
      if (acc) match = { kind: 'account', id: acc.id, name: acc.name };
    }
  }
  await db.insert(verifications).values({
    campaignId,
    query: q,
    number: identity.number,
    lid: identity.lid,
    result: !!match,
    collaboratorId: match?.kind === 'collaborator' ? match.id : null,
    checkedBy: opts.checkedBy ?? null,
    channel: opts.channel ?? 'painel',
  });
  return { valid, result: !!match, identity, match };
}

export async function verificationHistory(
  db: Db,
  campaignId: string,
  opts: { limit?: number } = {},
): Promise<VerificationRow[]> {
  return db
    .select()
    .from(verifications)
    .where(eq(verifications.campaignId, campaignId))
    .orderBy(desc(verifications.createdAt))
    .limit(Math.min(opts.limit ?? 50, 500));
}

/** Contadores por número consultado (mais consultados primeiro) + totais. */
export async function verificationCounts(db: Db, campaignId: string) {
  const byNumber = await db
    .select({
      key: sql<string>`coalesce(${verifications.number}, ${verifications.lid}, ${verifications.query})`,
      total: count(),
      positives: sql<number>`count(*) filter (where ${verifications.result})::int`,
      last: sql<Date>`max(${verifications.createdAt})`,
    })
    .from(verifications)
    .where(eq(verifications.campaignId, campaignId))
    .groupBy(sql`1`)
    .orderBy(desc(count()))
    .limit(100);
  const [t] = await db
    .select({ total: count(), positives: sql<number>`count(*) filter (where ${verifications.result})::int` })
    .from(verifications)
    .where(eq(verifications.campaignId, campaignId));
  return {
    total: Number(t?.total ?? 0),
    positives: Number(t?.positives ?? 0),
    byNumber: byNumber.map((r) => ({ ...r, total: Number(r.total), last: new Date(r.last) })),
  };
}
