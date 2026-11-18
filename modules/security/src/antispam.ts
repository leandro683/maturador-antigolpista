import { and, asc, eq, like, sql } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { isBlocked, type BlockedResult } from '../../blacklist/check';
import { addNumber, createList, updateList } from '../../blacklist/service';
import { lists } from '../../blacklist/tables';
import type { Identity } from './identity';
import {
  readSecuritySettings,
  recordSettingsHistory,
  writeSecuritySettings,
  type SecuritySettings,
} from './settings';
import { antiSpamGlobal } from './tables';

/**
 * Anti-spam em cima das listas de bloqueados — `isBlocked` continua a única regra de bloqueio:
 * - lista "Anti-hacker — {campanha}" (campaign_ids = [campanha]): autores pegos pelo anti-hacker daquela campanha;
 * - lista "Anti-spam compartilhado" (campaign_ids = campanhas com opt-in em `anti_spam_global`): incidentes de
 *   qualquer campanha com `sendToAntiSpam` alimentam; só bloqueia nas campanhas que aderiram. Sem adesão → desativada
 *   (campaign_ids vazio valeria p/ todas).
 * - `sharedBlocklistAllCampaigns` ligado → a lista compartilhada vale p/ TODAS as campanhas (campaign_ids vazio,
 *   ativa), independente do opt-in.
 */

export const ANTI_SPAM_LIST_NAME = 'Anti-spam compartilhado';
export const ANTI_HACKER_LIST_PREFIX = 'Anti-hacker — ';

async function antiSpamList(db: Db) {
  const [found] = await db.select().from(lists).where(eq(lists.name, ANTI_SPAM_LIST_NAME)).limit(1);
  return found ?? createList(db, { name: ANTI_SPAM_LIST_NAME, disabled: true });
}

export async function antiHackerList(db: Db, campaign: { id: string; name: string }) {
  const [found] = await db
    .select()
    .from(lists)
    .where(
      and(
        like(lists.name, `${ANTI_HACKER_LIST_PREFIX}%`),
        sql`${lists.campaignIds} = ARRAY[${campaign.id}]::uuid[]`,
      ),
    )
    .limit(1);
  return (
    found ??
    createList(db, {
      name: `${ANTI_HACKER_LIST_PREFIX}${campaign.name}`.slice(0, 80),
      campaignIds: [campaign.id],
    })
  );
}

/** Lista de campanhas com opt-in → campaign_ids da lista compartilhada (ou todas, com o interruptor global). */
export async function syncAntiSpamList(db: Db): Promise<{ listId: string; campaignIds: string[]; all: boolean }> {
  const list = await antiSpamList(db);
  if ((await readSecuritySettings(db)).sharedBlocklistAllCampaigns) {
    await updateList(db, list.id, { campaignIds: [], disabled: false });
    return { listId: list.id, campaignIds: [], all: true };
  }
  const rows = await db
    .select({ id: antiSpamGlobal.campaignId })
    .from(antiSpamGlobal)
    .where(eq(antiSpamGlobal.enabled, true))
    .orderBy(asc(antiSpamGlobal.campaignId));
  const ids = rows.map((r) => r.id);
  await updateList(db, list.id, { campaignIds: ids, disabled: ids.length === 0 });
  return { listId: list.id, campaignIds: ids, all: false };
}

/** Salva os interruptores globais (+ Histórico) e re-sincroniza a lista compartilhada. */
export async function saveSecuritySettings(
  db: Db,
  patch: Partial<SecuritySettings>,
  by?: string | null,
  ip?: string | null,
): Promise<SecuritySettings> {
  // config + lista compartilhada juntas: se o sync falhar, a config não fica salva pela metade
  const r = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const out = await writeSecuritySettings(t, patch, by);
    await syncAntiSpamList(t);
    return out;
  });
  await recordSettingsHistory(db, r, by, ip);
  return r.after;
}

export async function setAntiSpamOptIn(db: Db, campaignId: string, enabled: boolean, by?: string | null) {
  await db
    .insert(antiSpamGlobal)
    .values({ campaignId, enabled, updatedBy: by ?? null })
    .onConflictDoUpdate({
      target: antiSpamGlobal.campaignId,
      set: { enabled, updatedBy: by ?? null, updatedAt: sql`now()` },
    });
  return syncAntiSpamList(db);
}

export async function antiSpamOptIns(db: Db): Promise<Map<string, boolean>> {
  const rows = await db.select().from(antiSpamGlobal);
  return new Map(rows.map((r) => [r.campaignId, r.enabled]));
}

/** Autor pego pelo anti-hacker → lista da campanha (+ compartilhada se `toAntiSpam`). Nome "Hacker de mensagem …". */
export async function blockAuthor(
  db: Db,
  i: { campaign: { id: string; name: string }; who: Identity; name: string; toAntiSpam: boolean },
): Promise<string[]> {
  const value = i.who.number ?? (i.who.lid ? `${i.who.lid}@lid` : null);
  if (!value) return [];
  const out: string[] = [];
  const own = await antiHackerList(db, i.campaign);
  await addNumber(db, own.id, { value, name: i.name }, 'anti_hacker');
  out.push(own.id);
  if (i.toAntiSpam) {
    const shared = await antiSpamList(db);
    await addNumber(db, shared.id, { value, name: i.name }, 'anti_hacker');
    out.push(shared.id);
  }
  return out;
}

/**
 * Recusar/remover na entrada. Mesma regra de `isBlocked` com a campanha, exposta p/ quem decide
 * solicitação ou entrada. Número administrativo nunca é recusado.
 */
export async function shouldRejectJoin(
  db: Db,
  phoneOrLid: string,
  campaignId: string,
): Promise<{ reject: boolean } & BlockedResult> {
  const r = await isBlocked(db, phoneOrLid, { campaignId });
  return { reject: r.blocked, ...r };
}
