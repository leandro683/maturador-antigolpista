import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { brPhoneVariants } from '@mag/shared/phone';
import { normalizeEntry, type BlockKey } from './normalize';
import { admins, lists, numbers } from './tables';

/**
 * Um telefone/LID está bloqueado? Contrato usado para recusar entrada automaticamente e pelo anti-spam.
 * Regras: casa telefone com/sem 9º dígito; LID só com LID; número administrativo nunca é bloqueado;
 * lista desativada não conta; lista com `campaign_ids` só vale p/ essas campanhas (vazia = todas).
 */
export type BlockedResult = { blocked: boolean; admin: boolean; listIds: string[] };

export type BlockEntry = {
  listId: string;
  number: string | null;
  lid: string | null;
  campaignIds: string[];
  disabled: boolean;
};
export type AdminEntry = { number: string | null; lid: string | null };

function keyMatches(e: { number: string | null; lid: string | null }, key: BlockKey): boolean {
  if (key.lid) return e.lid === key.lid;
  return e.number !== null && brPhoneVariants(key.number!).includes(e.number);
}

/** Pura (testável e reutilizável com cache). */
export function matchBlocked(
  entries: readonly BlockEntry[],
  adminEntries: readonly AdminEntry[],
  key: BlockKey,
  campaignId?: string,
): BlockedResult {
  if (adminEntries.some((a) => keyMatches(a, key))) return { blocked: false, admin: true, listIds: [] };
  const listIds = [
    ...new Set(
      entries
        .filter(
          (e) =>
            !e.disabled &&
            (e.campaignIds.length === 0 ||
              (campaignId !== undefined && e.campaignIds.includes(campaignId))) &&
            keyMatches(e, key),
        )
        .map((e) => e.listId),
    ),
  ];
  return { blocked: listIds.length > 0, admin: false, listIds };
}

/** `phoneOrLid`: E.164, dígitos BR, JID `@c.us`/`@s.whatsapp.net` ou `@lid`. Inválido → não bloqueado. */
export async function isBlocked(
  db: Db,
  phoneOrLid: string,
  opts: { campaignId?: string } = {},
): Promise<BlockedResult> {
  const key = normalizeEntry(phoneOrLid);
  if (!key) return { blocked: false, admin: false, listIds: [] };
  const variants = key.number ? brPhoneVariants(key.number) : [];
  const numCond = key.lid ? eq(numbers.lid, key.lid) : inArray(numbers.number, variants);
  const admCond = key.lid ? eq(admins.lid, key.lid) : inArray(admins.number, variants);

  const adm = await db
    .select({ number: admins.number, lid: admins.lid })
    .from(admins)
    .where(admCond)
    .limit(1);
  if (adm.length) return { blocked: false, admin: true, listIds: [] };

  const rows = await db
    .select({
      listId: numbers.blacklistId,
      number: numbers.number,
      lid: numbers.lid,
      campaignIds: lists.campaignIds,
      disabled: lists.disabled,
    })
    .from(numbers)
    .innerJoin(lists, eq(lists.id, numbers.blacklistId))
    .where(and(numCond, eq(lists.disabled, false)));
  return matchBlocked(rows, [], key, opts.campaignId);
}
