/** Telefone BR (E.164, 9º dígito) e JIDs/LIDs do WhatsApp. */

const VALID_DDD = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48,
  49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

const digitsOf = (s: string) => s.replace(/\D/g, '');

/** Local BR (8 ou 9 dígitos) → com 9º dígito quando for celular. */
function brLocal(local: string): string | null {
  if (local.length === 9) return local.startsWith('9') ? local : null;
  if (local.length === 8) return /^[6-9]/.test(local) ? `9${local}` : local; // fixo 2–5 mantém 8
  return null;
}

/**
 * Normaliza p/ E.164 (`+55DDXXXXXXXXX`). `forceBr`: número sem DDI é tratado como BR.
 * Retorna null se inválido.
 */
export function toE164(input: string, opts: { forceBr?: boolean } = {}): string | null {
  const forceBr = opts.forceBr ?? true;
  const trimmed = input.trim();
  let d = digitsOf(trimmed);
  if (!d) return null;
  const hadPlus = trimmed.startsWith('+') || trimmed.startsWith('00');
  if (trimmed.startsWith('00')) d = d.slice(2);

  if (!hadPlus || d.startsWith('55')) {
    let national: string | null = null;
    if (d.startsWith('55') && (d.length === 12 || d.length === 13)) national = d.slice(2);
    else if (!hadPlus && forceBr) {
      const n = d.startsWith('0') ? d.replace(/^0+/, '') : d;
      if (n.length === 10 || n.length === 11) national = n;
    }
    if (national) {
      const ddd = Number(national.slice(0, 2));
      if (!VALID_DDD.has(ddd)) return null;
      const local = brLocal(national.slice(2));
      return local ? `+55${ddd}${local}` : null;
    }
    if (!hadPlus) return null;
  }
  return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
}

/** Variantes c/ e s/ 9º dígito (contas antigas aparecem sem o 9 no JID). */
export function brPhoneVariants(e164: string): string[] {
  const m = /^\+55(\d{2})(\d{8,9})$/.exec(e164);
  if (!m) return [e164];
  const [, ddd, local] = m as unknown as [string, string, string];
  if (local.length === 9 && local.startsWith('9')) return [e164, `+55${ddd}${local.slice(1)}`];
  if (local.length === 8 && /^[6-9]/.test(local)) return [`+55${ddd}9${local}`, e164];
  return [e164];
}

/**
 * Variantes de destino de qualquer entrada (E.164, dígitos, JID `@c.us`/`@s.whatsapp.net`), canônica (c/ 9)
 * primeiro. LID/grupo/inválido → []. O WhatsApp registra contas antigas SEM o 9 — tentar as duas ao enviar.
 */
export function brVariants(input: string): string[] {
  const at = input.lastIndexOf('@');
  let raw = input;
  if (at >= 0) {
    const p = parseJid(input);
    if (p.kind !== 'user') return [];
    raw = `+${p.user}`;
  }
  const e164 = toE164(raw);
  return e164 ? brPhoneVariants(e164) : [];
}

export type JidKind = 'user' | 'lid' | 'group' | 'broadcast' | 'newsletter' | 'unknown';
export type ParsedJid = { kind: JidKind; user: string; server: string; device?: number };

/** `user:device@server` → user/device/server. */
export function parseJid(jid: string): ParsedJid {
  const at = jid.lastIndexOf('@');
  if (at < 0) return { kind: 'unknown', user: jid, server: '' };
  const left = jid.slice(0, at);
  const server = jid.slice(at + 1);
  const [user = '', dev] = left.split(':');
  const device = dev !== undefined && /^\d+$/.test(dev) ? Number(dev) : undefined;
  const kind: JidKind =
    server === 'c.us' || server === 's.whatsapp.net'
      ? 'user'
      : server === 'lid'
        ? 'lid'
        : server === 'g.us'
          ? 'group'
          : server === 'broadcast'
            ? 'broadcast'
            : server === 'newsletter'
              ? 'newsletter'
              : 'unknown';
  return device === undefined ? { kind, user, server } : { kind, user, server, device };
}

export const isLid = (jid: string) => parseJid(jid).kind === 'lid';
export const isGroupJid = (jid: string) => parseJid(jid).kind === 'group';

/** JID de usuário (formato WAHA `@c.us`) a partir de E.164 ou dígitos. */
export function jidFromPhone(phone: string): string {
  const d = digitsOf(phone);
  if (!d) throw new Error('telefone vazio');
  return `${d}@c.us`;
}

/** E.164 de um JID de usuário; null p/ LID/grupo (LID não carrega telefone). */
export function phoneFromJid(jid: string): string | null {
  const p = parseJid(jid);
  if (p.kind !== 'user' || !/^\d{8,15}$/.test(p.user)) return null;
  return `+${p.user}`;
}
