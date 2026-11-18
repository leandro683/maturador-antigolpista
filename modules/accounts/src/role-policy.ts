import { z } from 'zod';
import type { RolePolicy } from '@mag/db/schema';

/**
 * Anti-ban por conta. `creator` só cria grupos, `sender` só envia, `both` os dois,
 * `spy` = conta espiã/observadora (usada pelo anti-golpista). Caps vazios = default do papel.
 */
export const ROLES = ['both', 'creator', 'sender', 'spy'] as const;
export type AccountRole = (typeof ROLES)[number];

export const ROLE_LABEL: Record<AccountRole, string> = {
  both: 'Cria e envia',
  creator: 'Criadora de grupos',
  sender: 'Envio de mensagens',
  spy: 'Espiã (observadora)',
};

export const DEFAULT_CAPS = {
  maxGroupCreatesPerDay: 20,
  minSecondsBetweenCreates: 60,
  maxGroupSendsPerHour: 200,
  warmupFactor: 0.5, // contas < 7 dias
} as const;

const cap = (max: number) => z.coerce.number().int().min(0).max(max).optional();

export const rolePolicySchema = z.object({
  role: z.enum(ROLES),
  maxGroupCreatesPerDay: cap(500),
  minSecondsBetweenCreates: cap(86_400),
  maxGroupSendsPerHour: cap(5_000),
  warmupFactor: z.coerce.number().min(0).max(1).optional(),
});

export function normalizeRolePolicy(input: unknown): RolePolicy {
  const p = rolePolicySchema.parse(input);
  const out: RolePolicy = { role: p.role };
  if (p.maxGroupCreatesPerDay !== undefined) out.maxGroupCreatesPerDay = p.maxGroupCreatesPerDay;
  if (p.minSecondsBetweenCreates !== undefined) out.minSecondsBetweenCreates = p.minSecondsBetweenCreates;
  if (p.maxGroupSendsPerHour !== undefined) out.maxGroupSendsPerHour = p.maxGroupSendsPerHour;
  if (p.warmupFactor !== undefined) out.warmupFactor = p.warmupFactor;
  return out;
}

/** Caps efetivos (default + override). `spy` e `sender` não criam; `spy` e `creator` não enviam. */
export function effectiveCaps(p: RolePolicy) {
  const creates = p.role === 'both' || p.role === 'creator';
  const sends = p.role === 'both' || p.role === 'sender';
  return {
    canCreateGroups: creates,
    canSend: sends,
    maxGroupCreatesPerDay: creates ? (p.maxGroupCreatesPerDay ?? DEFAULT_CAPS.maxGroupCreatesPerDay) : 0,
    minSecondsBetweenCreates: p.minSecondsBetweenCreates ?? DEFAULT_CAPS.minSecondsBetweenCreates,
    maxGroupSendsPerHour: sends ? (p.maxGroupSendsPerHour ?? DEFAULT_CAPS.maxGroupSendsPerHour) : 0,
    warmupFactor: p.warmupFactor ?? DEFAULT_CAPS.warmupFactor,
  };
}

export function isSpy(p: RolePolicy | null | undefined): boolean {
  return p?.role === 'spy';
}
