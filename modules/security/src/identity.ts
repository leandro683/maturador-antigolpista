import { brPhoneVariants } from '@mag/shared/phone';
import { normalizeEntry } from '../../blacklist/normalize';

/**
 * Identidade de um participante: telefone E.164 e/ou LID (dígitos). WAHA GOWS manda muito participante só com LID;
 * a allowlist casa por qualquer um dos dois (telefone com/sem 9º dígito).
 */
export type Identity = { number: string | null; lid: string | null };

export function identityOf(...values: (string | null | undefined)[]): Identity {
  const id: Identity = { number: null, lid: null };
  for (const v of values) {
    if (!v) continue;
    const k = normalizeEntry(v);
    if (!k) continue;
    if (k.number && !id.number) id.number = k.number;
    if (k.lid && !id.lid) id.lid = k.lid;
  }
  return id;
}

/** `lid` do engine já vem com `@lid` (mapper/getGroup); aceita também só os dígitos. Nunca duplica o sufixo. */
export const lidJid = (l?: string | null) => (l ? (l.endsWith('@lid') ? l : `${l}@lid`) : null);

export const sameIdentity = (a: Identity, b: Identity) =>
  (!!a.lid && a.lid === b.lid) ||
  (!!a.number && !!b.number && brPhoneVariants(a.number).includes(b.number));

/** Conjunto de identidades com busca por telefone (variantes BR) e LID. */
export class IdentitySet {
  private numbers = new Set<string>();
  private lids = new Set<string>();

  constructor(items: Iterable<Identity> = []) {
    for (const i of items) this.add(i);
  }

  add(i: Identity): this {
    if (i.number) for (const v of brPhoneVariants(i.number)) this.numbers.add(v);
    if (i.lid) this.lids.add(i.lid);
    return this;
  }

  clone(): IdentitySet {
    const c = new IdentitySet();
    this.numbers.forEach((n) => c.numbers.add(n));
    this.lids.forEach((l) => c.lids.add(l));
    return c;
  }

  has(i: Identity): boolean {
    return (!!i.lid && this.lids.has(i.lid)) || (!!i.number && this.numbers.has(i.number));
  }

  get size() {
    return this.numbers.size + this.lids.size;
  }
}

/** Texto curto p/ log/incidente: telefone, senão LID. */
export const label = (i: Identity) => i.number ?? (i.lid ? `${i.lid}@lid` : '?');

/** JID p/ chamar o engine (remove/demote): telefone `@c.us`, senão `@lid`. */
export function jidOf(i: Identity, fallback?: string): string {
  if (i.number) return `${i.number.replace(/^\+/, '')}@c.us`;
  if (i.lid) return `${i.lid}@lid`;
  return fallback ?? '';
}
