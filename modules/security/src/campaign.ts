import { count, eq, inArray } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { campaigns, waAccounts } from '@mag/db/schema';
import { admins } from '../../blacklist/tables';
import { antiSpamGlobal } from './tables';
import {
  antiHackerSchema,
  readAntiHacker,
  readiness,
  READINESS_MESSAGE,
  type AntiHackerConfig,
  type AntiHackerInput,
  type Readiness,
} from './config';
import { setAntiSpamOptIn } from './antispam';

/** Config anti-hacker da campanha + pré-requisitos + opt-in anti-spam. */

export type CampaignSecurity = {
  campaign: { id: string; name: string };
  config: AntiHackerConfig;
  readiness: Readiness;
  antiSpamOptIn: boolean;
  accounts: { id: string; name: string; role: string; status: string }[];
};

// `raw` = jsonb anti_hacker como está no banco (o salvar faz merge sobre ele sem reler a campanha)
async function loadSecurity(db: Db, campaignId: string): Promise<(CampaignSecurity & { raw: unknown }) | null> {
  const [c] = await db
    .select({ id: campaigns.id, name: campaigns.name, antiHacker: campaigns.antiHacker, ids: campaigns.accountIds })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!c) return null;
  const accs = c.ids?.length
    ? await db
        .select({ id: waAccounts.id, name: waAccounts.name, status: waAccounts.status, rolePolicy: waAccounts.rolePolicy })
        .from(waAccounts)
        .where(inArray(waAccounts.id, c.ids))
    : [];
  const [adm] = await db.select({ n: count() }).from(admins);
  const [opt] = await db
    .select({ enabled: antiSpamGlobal.enabled })
    .from(antiSpamGlobal)
    .where(eq(antiSpamGlobal.campaignId, campaignId));
  return {
    raw: c.antiHacker,
    campaign: { id: c.id, name: c.name },
    config: readAntiHacker(c.antiHacker),
    readiness: readiness({ accounts: accs, adminNumbers: Number(adm?.n ?? 0) }),
    antiSpamOptIn: opt?.enabled ?? false,
    accounts: accs.map((a) => ({ id: a.id, name: a.name, role: a.rolePolicy?.role ?? 'both', status: a.status })),
  };
}

export async function campaignSecurity(db: Db, campaignId: string): Promise<CampaignSecurity | null> {
  const s = await loadSecurity(db, campaignId);
  if (!s) return null;
  const { raw: _raw, ...pub } = s;
  return pub;
}

/**
 * Salva a config (merge sobre o jsonb atual — preserva chaves que outro formulário grave). Ligar sem conta espiã ou sem números
 * administrativos é recusado.
 */
export async function saveAntiHacker(
  db: Db,
  campaignId: string,
  input: AntiHackerInput & { antiSpamOptIn?: boolean },
  by?: string | null,
): Promise<AntiHackerConfig> {
  const { antiSpamOptIn, ...rest } = input;
  const cfg = antiHackerSchema.parse(rest);
  const cur = await loadSecurity(db, campaignId);
  if (!cur) throw new Error('campanha não encontrada');
  if (cfg.enabled && !cur.readiness.ok) throw new Error(`${READINESS_MESSAGE} (${cur.readiness.missing.join('; ')})`);
  const merged = { ...((cur.raw as Record<string, unknown> | null) ?? {}), ...cfg };
  await db.update(campaigns).set({ antiHacker: merged }).where(eq(campaigns.id, campaignId));
  if (antiSpamOptIn !== undefined && antiSpamOptIn !== cur.antiSpamOptIn)
    await setAntiSpamOptIn(db, campaignId, antiSpamOptIn, by);
  return cfg;
}
