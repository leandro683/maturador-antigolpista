import { brPhoneVariants } from '@mag/shared/phone';
import type { WaEngine } from '@mag/wa-engine';
import { identityOf, lidJid, sameIdentity, type Identity, type IdentitySet } from './identity';
import type { SecRepo } from './repo';

export type RemovalCheck = { ok: true; jid: string } | { ok: false; reason: string };
export type GuardEngine = Pick<WaEngine, 'getGroup'> & Partial<Pick<WaEngine, 'phoneOfLid'>>;
export type GuardRepo = Pick<SecRepo, 'agencyAccounts'>;

// `IdentitySet.has` testa só o número como veio; celular cadastrado sem o 9 (8 dígitos começando em 2–5, que o
// normalizador trata como fixo) não casa com o mesmo número chegando com o 9. Aqui testa também as variantes.
const listed = (allow: IdentitySet, x: Identity) =>
  allow.has(x) || (!!x.number && brPhoneVariants(x.number).some((n) => allow.has({ number: n, lid: null })));
const same = (a: Identity, b: Identity) => sameIdentity(a, b) || sameIdentity(b, a);

/** Identidade só com LID ganha o telefone (a lista oficial casa por número); sem sessão ou em qualquer falha devolve como veio. */
export async function resolveIdentity(
  engine: Partial<Pick<WaEngine, 'phoneOfLid'>>,
  session: string | null | undefined,
  id: Identity,
  jid: string,
): Promise<Identity> {
  if (id.number || !id.lid || !session) return id;
  try {
    const phone = await engine.phoneOfLid?.(session, lidJid(id.lid) ?? jid);
    const full = identityOf(phone, lidJid(id.lid));
    return full.number ? full : id;
  } catch {
    return id;
  }
}

/**
 * Única porta para remover alguém no recurso anti-impostor (entrada no grupo e botão "Remover" do operador).
 * Só devolve `ok: true` com confirmação positiva do próprio grupo; qualquer dúvida é recusa. Para no 1º "não".
 * A trava monta sozinha a lista do que nunca se toca: `allow` do chamador + TODAS as contas do painel (da campanha ou
 * não), numa cópia — quem chama não precisa lembrar de juntar nada.
 */
export async function confirmRemovable(i: {
  engine: GuardEngine;
  session: string;
  gid: string;
  who: Identity;
  allow: IdentitySet;
  repo: GuardRepo;
}): Promise<RemovalCheck> {
  const allow = i.allow.clone();
  try {
    for (const a of await i.repo.agencyAccounts()) allow.add(a);
  } catch {
    return { ok: false, reason: 'não foi possível conferir as contas do painel' };
  }
  let participants: Awaited<ReturnType<GuardEngine['getGroup']>>['participants'];
  try {
    participants = (await i.engine.getGroup(i.session, i.gid)).participants;
  } catch {
    return { ok: false, reason: 'não foi possível conferir o grupo' };
  }
  const idOf = (p: (typeof participants)[number]) => identityOf(p.jid, lidJid(p.lid));
  // todas as entradas da mesma pessoa (telefone, variante ou LID): basta uma ser admin ou da lista para recusar
  let matches = participants.filter((x) => same(idOf(x), i.who));
  // entradas ligadas entre si (uma traz telefone+LID, outra só um deles) são a mesma pessoa, mesmo que quem chegou não
  // traga o elo: amplia até não achar mais nenhuma
  for (let n = -1; n !== matches.length; ) {
    n = matches.length;
    matches = participants.filter((x) => same(idOf(x), i.who) || matches.some((m) => same(idOf(x), idOf(m))));
  }
  const p = matches[0];
  if (!p) return { ok: false, reason: 'não confirmado na lista do grupo' };
  if (matches.some((x) => x.isAdmin || x.isSuperAdmin)) return { ok: false, reason: 'é admin do grupo' };
  if (listed(allow, i.who)) return { ok: false, reason: 'está na lista oficial' };
  for (const x of matches) {
    const id = idOf(x);
    if (listed(allow, id)) return { ok: false, reason: 'está na lista oficial' };
    if (id.number) continue;
    const full = await resolveIdentity(i.engine, i.session, id, x.jid);
    if (!full.number) return { ok: false, reason: 'sem telefone para conferir a lista oficial' };
    if (listed(allow, full)) return { ok: false, reason: 'está na lista oficial' };
  }
  return { ok: true, jid: p.jid };
}
