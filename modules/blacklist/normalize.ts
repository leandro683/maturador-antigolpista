import { parseJid, phoneFromJid, toE164 } from '@mag/shared/phone';

/** Entrada normalizada de bloqueio: telefone E.164 ou LID (só dígitos, sem `@lid`). */
export type BlockKey = { number: string; lid?: never } | { lid: string; number?: never };
export type EntryKind = 'auto' | 'phone' | 'lid';

/**
 * `auto`: JID `@c.us`/`@s.whatsapp.net` → telefone; `@lid` → LID; resto → telefone (BR por padrão).
 * LID não carrega telefone — só casa com LID.
 */
export function normalizeEntry(raw: string, kind: EntryKind = 'auto'): BlockKey | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.includes('@')) {
    const j = parseJid(s);
    if (j.kind === 'lid') return /^\d{6,20}$/.test(j.user) ? { lid: j.user } : null;
    const p = phoneFromJid(s);
    return p ? (normalizeEntry(p, 'phone') as BlockKey | null) : null;
  }
  if (kind === 'lid') {
    const d = s.replace(/\D/g, '');
    return /^\d{6,20}$/.test(d) && d.length === s.replace(/[\s-]/g, '').length ? { lid: d } : null;
  }
  const e = toE164(s, { forceBr: true });
  return e ? { number: e } : null;
}
