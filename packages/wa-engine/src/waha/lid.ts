import type { GroupInfo, WaEngine } from '../types';
import type { WahaWebhook } from './mapper';

/**
 * Mapeamento LID → telefone. No GOWS `group.v2.participants` chega com `pn:null` (só `@lid`); o telefone
 * aparece às vezes em outros campos do mesmo webhook (`_data.Sender/SenderPN`, `requesterPn`, `me`) e sempre no
 * `getGroup` (GOWS devolve `PhoneNumber` + `LID`). Resolver = cache em memória → store (tabela `lid_map`) →
 * engine.getGroup do grupo do evento. Sem telefone, o participante fica só-LID e é corrigido quando a dica chegar.
 */

export type LidHint = { lid: string; phone: string };

type Obj = Record<string, unknown>;

/** `user[:device]@server` → partes (sem depender de pacote externo). */
function splitJid(jid: string): { user: string; server: string } {
  const at = jid.lastIndexOf('@');
  if (at < 0) return { user: jid, server: '' };
  return { user: jid.slice(0, at).split(':')[0] ?? '', server: jid.slice(at + 1) };
}

/** Dígitos → E.164; BR celular sem 9º dígito (55 + DDD + 8 começando em 6–9) ganha o 9 (= toE164 do shared). */
export function canonicalPhone(digits: string): string | null {
  if (!/^\d{8,15}$/.test(digits)) return null;
  if (/^55\d{2}[6-9]\d{7}$/.test(digits)) return `+${digits.slice(0, 4)}9${digits.slice(4)}`;
  return `+${digits}`;
}

/** Chave de telefone canônica de um JID de usuário (`@c.us`/`@s.whatsapp.net`) ou `+dígitos`; null p/ LID/grupo. */
export function phoneOfJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  if (/^\+\d{8,15}$/.test(jid)) return canonicalPhone(jid.slice(1));
  const { user, server } = splitJid(jid);
  if (server !== 'c.us' && server !== 's.whatsapp.net') return null;
  return canonicalPhone(user);
}

/** `100000000000002@lid` normalizado (sem device); null se não for LID. */
export function lidOf(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const { user, server } = splitJid(jid);
  return server === 'lid' && /^\d+$/.test(user) ? `${user}@lid` : null;
}

function hint(lidRaw: unknown, pnRaw: unknown): LidHint | null {
  const lid = typeof lidRaw === 'string' ? lidOf(lidRaw) : null;
  const phone = typeof pnRaw === 'string' ? phoneOfJid(pnRaw) : null;
  return lid && phone ? { lid, phone } : null;
}

/** Todas as dicas LID↔telefone presentes num webhook WAHA cru (qualquer evento). */
export function lidHintsFromWebhook(w: WahaWebhook): LidHint[] {
  const p = (w.payload ?? {}) as Obj;
  const out: (LidHint | null)[] = [];
  for (const x of (Array.isArray(p.participants) ? p.participants : []) as Obj[])
    out.push(hint(x.id, x.pn ?? x.phoneNumber));
  out.push(hint(p.requesterId, p.requesterPn));
  const d = (p._data ?? {}) as Obj;
  out.push(hint(d.Sender, d.SenderPN));
  const me = (w.me ?? {}) as Obj;
  out.push(hint(me.lid, me.id));
  const seen = new Set<string>();
  return out.filter((h): h is LidHint => {
    if (!h || seen.has(h.lid)) return false;
    seen.add(h.lid);
    return true;
  });
}

/** Dicas a partir de um GroupInfo (getGroup): participantes com telefone e LID. */
export function lidHintsFromGroup(g: GroupInfo): LidHint[] {
  return g.participants.map((x) => hint(x.lid, x.jid)).filter((h): h is LidHint => h !== null);
}

/** Persistência do mapa (Drizzle: tabela `lid_map`; memória em teste). */
export interface LidStore {
  get(lids: string[]): Promise<Map<string, string>>;
  put(hints: LidHint[], source: string): Promise<void>;
}

export class MemoryLidStore implements LidStore {
  readonly map = new Map<string, string>();
  async get(lids: string[]) {
    return new Map(lids.filter((l) => this.map.has(l)).map((l) => [l, this.map.get(l)!]));
  }
  async put(hints: LidHint[]) {
    for (const h of hints) this.map.set(h.lid, h.phone);
  }
}

export type LidResolverOptions = {
  engine?: Pick<WaEngine, 'getGroup'> & Partial<Pick<WaEngine, 'phoneOfLid'>>;
  /** tamanho máximo do cache em memória (LRU simples) */
  max?: number;
  /** intervalo mínimo entre getGroup do mesmo grupo (evita martelar o WAHA em rajada de entradas) */
  groupCooldownMs?: number;
  /** máximo de `phoneOfLid` por chamada de resolve */
  maxLidLookups?: number;
  now?: () => number;
};

export class LidResolver {
  private cache = new Map<string, string>();
  private lastGroupFetch = new Map<string, number>();

  constructor(
    private readonly store: LidStore,
    private readonly opts: LidResolverOptions = {},
  ) {}

  private remember(lid: string, phone: string) {
    this.cache.delete(lid);
    this.cache.set(lid, phone);
    const max = this.opts.max ?? 50_000;
    while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value as string);
  }

  /** Grava dicas (cache + store). */
  async learn(hints: LidHint[], source = 'event'): Promise<void> {
    const fresh = hints.filter((h) => this.cache.get(h.lid) !== h.phone);
    for (const h of hints) this.remember(h.lid, h.phone);
    if (fresh.length) await this.store.put(fresh, source);
  }

  /**
   * Resolve LIDs → telefone. `ctx.session/gid` habilitam o fallback `getGroup` (1 chamada por grupo, com
   * cooldown); `ctx.session` habilita o `phoneOfLid` (`GET /api/{s}/lids/{lid}`) p/ o que sobrar.
   * Retorna só os resolvidos.
   */
  async resolve(lids: string[], ctx: { session?: string; gid?: string } = {}): Promise<Map<string, string>> {
    const want = [...new Set(lids.map((l) => lidOf(l)).filter((l): l is string => l !== null))];
    const out = new Map<string, string>();
    let missing = want.filter((l) => {
      const hit = this.cache.get(l);
      if (hit) out.set(l, hit);
      return !hit;
    });
    if (missing.length) {
      for (const [l, ph] of await this.store.get(missing)) {
        out.set(l, ph);
        this.remember(l, ph);
      }
      missing = missing.filter((l) => !out.has(l));
    }
    const { engine } = this.opts;
    if (missing.length && engine && ctx.session && ctx.gid) {
      const now = (this.opts.now ?? Date.now)();
      const last = this.lastGroupFetch.get(ctx.gid) ?? -Infinity;
      if (now - last >= (this.opts.groupCooldownMs ?? 5_000)) {
        this.lastGroupFetch.set(ctx.gid, now);
        try {
          const hints = lidHintsFromGroup(await engine.getGroup(ctx.session, ctx.gid));
          await this.learn(hints, 'getGroup');
          for (const h of hints) if (missing.includes(h.lid)) out.set(h.lid, h.phone);
        } catch {
          // engine fora do ar: segue só-LID; reconcile corrige depois
        }
      }
      missing = missing.filter((l) => !out.has(l));
    }
    if (missing.length && engine?.phoneOfLid && ctx.session) {
      const learned: LidHint[] = [];
      for (const l of missing.slice(0, this.opts.maxLidLookups ?? 20)) {
        try {
          const phone = phoneOfJid(await engine.phoneOfLid(ctx.session, l));
          if (phone) {
            learned.push({ lid: l, phone });
            out.set(l, phone);
          }
        } catch {
          // sem mapa no servidor: segue só-LID
        }
      }
      if (learned.length) await this.learn(learned, 'lids-api');
    }
    return out;
  }
}
