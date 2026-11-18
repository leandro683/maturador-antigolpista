import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@mag/db';
import { recordHistory } from './record';
import { securitySettings } from './tables';

/**
 * Interruptores globais do anti-spam (tabela `security_settings`, 1 linha `global`; ausente = padrões).
 * - `antiSpamAssociatedOnly` (padrão ligado = comportamento de antes): só as contas associadas à campanha agem no
 *   grupo. Desligado: outra conta nossa que esteja no grupo (participante ativo em `group_participants`) também pode
 *   agir quando nenhuma conta da campanha estiver conectada — e nunca é tratada como invasora.
 * - `sharedBlocklistAllCampaigns` (padrão desligado): a lista "Anti-spam compartilhado" bloqueia só nas campanhas com
 *   opt-in (`anti_spam_global`). Ligado: vale p/ todas as campanhas (`campaign_ids` vazio na blacklist).
 * Handlers em tempo real leem com cache de 60 s (`cachedSettings`).
 */

export const securitySettingsSchema = z.object({
  antiSpamAssociatedOnly: z.boolean().default(true),
  sharedBlocklistAllCampaigns: z.boolean().default(false),
});

export type SecuritySettings = z.output<typeof securitySettingsSchema>;
export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = securitySettingsSchema.parse({});

/** Leitura tolerante: campo inválido/ausente cai no padrão. */
export function readSecuritySettingsValue(raw: unknown): SecuritySettings {
  const out: SecuritySettings = { ...DEFAULT_SECURITY_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.antiSpamAssociatedOnly === 'boolean') out.antiSpamAssociatedOnly = r.antiSpamAssociatedOnly;
  if (typeof r.sharedBlocklistAllCampaigns === 'boolean') out.sharedBlocklistAllCampaigns = r.sharedBlocklistAllCampaigns;
  return out;
}

export async function readSecuritySettings(db: Db): Promise<SecuritySettings & { updatedAt: Date | null; updatedBy: string | null }> {
  const [row] = await db.select().from(securitySettings).where(eq(securitySettings.id, 'global')).limit(1);
  return { ...readSecuritySettingsValue(row?.value), updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null };
}

/**
 * Salva (merge). Histórico e sincronização da lista compartilhada ficam com quem chama (`saveSecuritySettings` em
 * antispam.ts: upsert + sync numa transação, Histórico depois) p/ não criar import circular.
 */
export async function writeSecuritySettings(
  db: Db,
  patch: Partial<SecuritySettings>,
  by?: string | null,
): Promise<{ before: SecuritySettings; after: SecuritySettings }> {
  const cur = await readSecuritySettings(db);
  const before: SecuritySettings = {
    antiSpamAssociatedOnly: cur.antiSpamAssociatedOnly,
    sharedBlocklistAllCampaigns: cur.sharedBlocklistAllCampaigns,
  };
  const after = securitySettingsSchema.parse({ ...before, ...patch });
  await db
    .insert(securitySettings)
    .values({ id: 'global', value: after, updatedBy: by ?? null })
    .onConflictDoUpdate({ target: securitySettings.id, set: { value: after, updatedBy: by ?? null, updatedAt: sql`now()` } });
  return { before, after };
}

/** Histórico da mudança (só quando algo mudou). */
export async function recordSettingsHistory(
  db: Db,
  r: { before: SecuritySettings; after: SecuritySettings },
  by?: string | null,
  ip?: string | null,
) {
  if (JSON.stringify(r.before) === JSON.stringify(r.after)) return;
  await recordHistory(db, {
    location: 'seguranca',
    type: 'security.settings.update',
    entityIds: ['global'],
    before: r.before,
    after: r.after,
    memberId: by ?? null,
    ip: ip ?? null,
  });
}

/** Cache simples (TTL) p/ os handlers: 1 leitura do banco por minuto por processo; erro → último valor/padrão. */
export function cachedSettings(
  load: () => Promise<SecuritySettings>,
  ttlMs = 60_000,
  now: () => number = Date.now,
): () => Promise<SecuritySettings> {
  let value: SecuritySettings | null = null;
  let at = -Infinity;
  let inflight: Promise<SecuritySettings> | null = null;
  return async () => {
    if (value && now() - at < ttlMs) return value;
    inflight ??= load()
      .then((v) => {
        value = v;
        at = now();
        return v;
      })
      .catch(() => value ?? { ...DEFAULT_SECURITY_SETTINGS })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}
