import type { waAccounts } from '@mag/db/schema';

/**
 * Anti-ban (só leitura de `wa_accounts.role_policy`, com padrões): papel `spy` não age, `creator` não envia
 * mensagem, conta com bloqueio de envio (timelock / suspensão / restrita) não é roteável.
 */

export type AccountRole = 'creator' | 'sender' | 'both' | 'spy';
export type RolePolicyLike = { role: AccountRole };
export type ActionCapability = 'send' | 'manage';
export type AccountLite = Pick<
  typeof waAccounts.$inferSelect,
  'id' | 'status' | 'rolePolicy' | 'createdAt' | 'reachoutTimelock' | 'whatsappSuspension'
>;

export const TIMELOCK_DEFAULT_MS = 15 * 60_000;
const CONNECTED = new Set(['connected', 'active']);

const canSend = (p: RolePolicyLike) => p.role === 'sender' || p.role === 'both';

export function policyWithDefaults(p: Partial<RolePolicyLike> | null | undefined): RolePolicyLike {
  return { role: p?.role ?? 'both' };
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Fim do timelock ativo (ou null). `restricted` sem data = TIMELOCK_DEFAULT_MS a partir de agora. */
export function timelockUntil(a: AccountLite, now: Date): Date | null {
  const ends = [a.reachoutTimelock, a.whatsappSuspension]
    .map((o) => parseDate(o?.endsAt ?? o?.until ?? o?.expiresAt))
    .filter((d): d is Date => !!d && d > now);
  if (ends.length) return new Date(Math.max(...ends.map((d) => d.getTime())));
  if (a.whatsappSuspension && !a.whatsappSuspension.endsAt && a.whatsappSuspension.active !== false)
    return new Date(now.getTime() + TIMELOCK_DEFAULT_MS);
  if (a.status === 'restricted' && !a.reachoutTimelock) return new Date(now.getTime() + TIMELOCK_DEFAULT_MS);
  return null;
}

export function roleAllows(p: RolePolicyLike, cap: ActionCapability): boolean {
  if (p.role === 'spy') return false;
  return cap === 'send' ? canSend(p) : true;
}

/** Elegível p/ enviar (status conectado, papel, sem timelock). */
export function isRoutable(a: AccountLite, cap: ActionCapability, now: Date): boolean {
  const restrictedButExpired = a.status === 'restricted' && !timelockUntil(a, now);
  return (
    (CONNECTED.has(a.status) || restrictedButExpired) &&
    roleAllows(policyWithDefaults(a.rolePolicy), cap) &&
    !timelockUntil(a, now)
  );
}
