import { isConnected, type AccStatus } from '@mag/accounts';

export type ChipBadge = { tone: 'ok' | 'warn' | 'bad'; text: string; dot?: boolean };

/** Selo do chip no maturador. O status real da conta é `connected` (ou `active`); `restricted` ainda conversa, com aviso. */
export function chipBadge(c: { active: boolean; pausedReason: string | null; status: string }): ChipBadge {
  if (!c.active) return { tone: 'warn', text: `Pausado${c.pausedReason ? `: ${c.pausedReason}` : ''}` };
  if (!isConnected(c.status as AccStatus)) return { tone: 'bad', text: 'Conta desconectada' };
  if (c.status === 'restricted') return { tone: 'warn', text: 'Restrito' };
  return { tone: 'ok', text: 'Aquecendo', dot: true };
}
