import type { GroupInfo } from '@mag/wa-engine';
import { compilePatterns, type AntiHackerConfig } from './config';
import { identityOf, label, lidJid, type Identity, type IdentitySet } from './identity';
import { hamming, PHOTO_MATCH_DISTANCE } from './photo';

/** Decisões puras do anti-hacker (sem banco/engine) — testáveis com fixtures. */

export type MessageVerdict =
  | { violation: false; reason: 'allowlisted' | 'open-group' | 'admin' }
  | { violation: true; reason: 'closed-group' | 'suspicious'; matched?: string };

/**
 * Mensagem em grupo.
 * - autor na allowlist (números administrativos, contas da campanha, colaboradores, extras) → ok;
 * - grupo fechado (só admins falam) → qualquer mensagem de fora da allowlist é violação;
 * - grupo aberto → só conteúdo suspeito (regex configurável) e só se `flagSuspiciousContent`.
 */
export function judgeMessage(i: {
  author: Identity;
  allow: IdentitySet;
  closed: boolean;
  body?: string;
  cfg: Pick<AntiHackerConfig, 'flagSuspiciousContent' | 'suspiciousPatterns'>;
}): MessageVerdict {
  if (i.allow.has(i.author)) return { violation: false, reason: 'allowlisted' };
  if (i.closed) return { violation: true, reason: 'closed-group' };
  if (i.cfg.flagSuspiciousContent && i.body) {
    for (const re of compilePatterns(i.cfg.suspiciousPatterns)) {
      const m = re.exec(i.body);
      if (m) return { violation: true, reason: 'suspicious', matched: m[0].slice(0, 80) };
    }
  }
  return { violation: false, reason: 'open-group' };
}

/**
 * Autor da mensagem reagida a partir do id serializado do WAHA (`{fromMe}_{chat}_{id}_{autor}`). A reação
 * traz só o id da mensagem; sem o 4º pedaço (id curto) o autor é desconhecido e nada é feito.
 */
export function messageAuthor(serialized: string): { fromMe: boolean; author: string | null } {
  const m = /^(true|false)_([^_]+)_([^_]+)_([^_]+)$/.exec(serialized);
  return m ? { fromMe: m[1] === 'true', author: m[4]! } : { fromMe: false, author: null };
}

/** Grupo fechado =`groups.settings.announce` (estado real sincronizado do WhatsApp) senão o template da campanha. */
export function isClosed(settings: Record<string, unknown> | null | undefined, onlyAdminsSpeak?: boolean) {
  const a = settings?.announce;
  return typeof a === 'boolean' ? a : Boolean(onlyAdminsSpeak);
}

export type AdminAudit = { offenders: { jid: string; identity: Identity; label: string; superAdmin: boolean }[] };

/**
 * Dry-run/auditoria: admins do grupo (getGroup) fora da allowlist. Não age — usado pelo botão
 * "auditar admins".
 */
export function auditGroupAdmins(g: GroupInfo, allow: IdentitySet): AdminAudit {
  const offenders = g.participants
    .filter((p) => p.isAdmin || p.isSuperAdmin)
    .map((p) => ({ p, id: identityOf(p.jid, lidJid(p.lid)) }))
    .filter(({ id }) => !allow.has(id))
    .map(({ p, id }) => ({ jid: p.jid, identity: id, label: label(id), superAdmin: p.isSuperAdmin }));
  return { offenders };
}

/** Código puro do convite: aceita o link completo (`https://chat.whatsapp.com/ABC?x=1`) ou o código. */
export function inviteCodeOf(v: string | null | undefined): string | null {
  const code = (v ?? '').trim().replace(/^https?:\/\/chat\.whatsapp\.com\//i, '').split(/[?#]/)[0]!.trim();
  return code || null;
}

/** Campos de group.update que mudaram em relação ao esperado (painel). Só nome e descrição são revertidos; descrição nula conta como vazia. */
export function changedFields(
  e: { subject?: string; description?: string; inviteCode?: string },
  expected: { name: string; description: string | null; inviteCode: string | null },
): { subject?: string; description?: string; inviteCode?: string } {
  const out: { subject?: string; description?: string; inviteCode?: string } = {};
  if (e.subject !== undefined && e.subject !== expected.name) out.subject = e.subject;
  // descrição gravada vazia (null) vale como vazia: quem não é da lista não pode ser o primeiro a defini-la
  if (e.description !== undefined && e.description !== (expected.description ?? ''))
    out.description = e.description;
  if (e.inviteCode !== undefined && expected.inviteCode && inviteCodeOf(e.inviteCode) !== inviteCodeOf(expected.inviteCode))
    out.inviteCode = e.inviteCode;
  return out;
}

export type ProfileVerdict =
  | { match: 'photo'; matched: string; distance: number }
  | { match: 'name'; matched: string }
  | { match: null };

/**
 * Impostor: foto de perfil parecida com uma de referência (dHash) ou nome casando um padrão. Foto tem precedência.
 * O nome é truncado em 100 caracteres antes do teste (limita regex custosa).
 */
export function judgeProfile(i: {
  name?: string | null;
  photoHash?: string | null;
  cfg: Pick<AntiHackerConfig, 'impersonationPhotos' | 'impersonationNames'>;
}): ProfileVerdict {
  if (i.photoHash) {
    let best: { label: string; distance: number } | null = null;
    for (const p of i.cfg.impersonationPhotos) {
      const distance = hamming(i.photoHash, p.hash);
      if (distance <= PHOTO_MATCH_DISTANCE && (!best || distance < best.distance)) best = { label: p.label, distance };
    }
    if (best) return { match: 'photo', matched: best.label.slice(0, 80), distance: best.distance };
  }
  const name = i.name?.slice(0, 100);
  if (name) {
    for (const re of compilePatterns(i.cfg.impersonationNames)) {
      const m = re.exec(name);
      if (m) return { match: 'name', matched: m[0].slice(0, 80) };
    }
  }
  return { match: null };
}
