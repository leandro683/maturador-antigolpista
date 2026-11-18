import type { MessageBlock, PerJidResult, SendOptions, WaEngine } from '../types';
import type { LidHint, LidStore } from './lid';
import { WahaHttpError } from './client';

/**
 * Destino real de um envio por telefone. O contato é guardado com a chave canônica (BR com 9º dígito), mas o
 * WhatsApp registra contas antigas SEM o 9 e o GOWS responde `500 no LID found for <telefone>@s.whatsapp.net`
 * quando o JID não existe. Ordem: cache em memória → LID conhecido (`lid_map`, via store) →
 * `checkNumber` em cada variante (c/ e s/ 9). Resultado cacheado; LID aprendido vai p/ o store.
 */

/** Dígitos de um telefone/JID de usuário; null p/ LID, grupo, broadcast etc. */
export function phoneDigitsOf(input: string): string | null {
  const at = input.lastIndexOf('@');
  if (at >= 0) {
    const server = input.slice(at + 1);
    if (server !== 'c.us' && server !== 's.whatsapp.net') return null;
    const user = input.slice(0, at).split(':')[0] ?? '';
    return /^\d{8,15}$/.test(user) ? user : null;
  }
  const d = input.replace(/\D/g, '');
  return /^\d{8,15}$/.test(d) ? d : null;
}

/** Variantes em dígitos, canônica (c/ 9) primeiro (= brVariants do shared, sem validar DDD). */
export function phoneVariantsOf(digits: string): string[] {
  const with9 = /^55(\d{2})(9\d{8})$/.exec(digits);
  if (with9) return [digits, `55${with9[1]}${with9[2]!.slice(1)}`];
  const without9 = /^55(\d{2})([6-9]\d{7})$/.exec(digits);
  if (without9) return [`55${without9[1]}9${without9[2]}`, digits];
  return [digits];
}

/** Store com consulta reversa telefone → LID (Drizzle: `lid_map`). */
export type PhoneLidStore = LidStore & { byPhone?(phones: string[]): Promise<Map<string, string>> };

export type ChatIdResolution = {
  /** JID a usar no engine */
  jid: string;
  /** JID de telefone real (variante que existe no WhatsApp), quando conhecido */
  phoneJid?: string;
  lid?: string;
  exists: boolean;
  via: 'passthrough' | 'cache' | 'store' | 'check' | 'unchecked';
};

type Entry = { phoneJid?: string; lid?: string; exists: boolean; at: number };

export type ChatIdResolverOptions = {
  store?: PhoneLidStore;
  /** validade do cache positivo (padrão 7 dias) */
  ttlMs?: number;
  /** validade do "não existe" (padrão 10 min) */
  negativeTtlMs?: number;
  max?: number;
  now?: () => number;
};

export class WaNumberNotFoundError extends Error {
  constructor(public readonly phone: string) {
    super(`número sem WhatsApp: ${phone} (variantes c/ e s/ 9º dígito)`);
    this.name = 'WaNumberNotFoundError';
  }
}

export type ResolveFor = 'send' | 'participant';

export class ChatIdResolver {
  private cache = new Map<string, Entry>();

  constructor(
    private readonly engine: Pick<WaEngine, 'checkNumber'>,
    private readonly opts: ChatIdResolverOptions = {},
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private put(key: string, e: Entry) {
    this.cache.delete(key);
    this.cache.set(key, e);
    const max = this.opts.max ?? 50_000;
    while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value as string);
  }

  private fresh(key: string): Entry | undefined {
    const e = this.cache.get(key);
    if (!e) return undefined;
    const ttl = e.exists ? (this.opts.ttlMs ?? 7 * 86_400_000) : (this.opts.negativeTtlMs ?? 600_000);
    if (this.now() - e.at > ttl) {
      this.cache.delete(key);
      return undefined;
    }
    return e;
  }

  invalidate(phoneOrJid: string) {
    const d = phoneDigitsOf(phoneOrJid);
    if (d) this.cache.delete(phoneVariantsOf(d)[0]!);
  }

  /** Grava o destino que funcionou (ex.: retry após `no LID found`). */
  remember(phoneOrJid: string, phoneJid: string) {
    const d = phoneDigitsOf(phoneOrJid);
    if (!d) return;
    const key = phoneVariantsOf(d)[0]!;
    this.put(key, { ...this.cache.get(key), phoneJid, exists: true, at: this.now() });
  }

  private pick(e: Entry, purpose: ResolveFor, via: ChatIdResolution['via'], fallback: string): ChatIdResolution {
    const jid = (purpose === 'send' ? (e.lid ?? e.phoneJid) : (e.phoneJid ?? e.lid)) ?? fallback;
    return { jid, phoneJid: e.phoneJid, lid: e.lid, exists: e.exists, via };
  }

  /**
   * `send` prefere o LID (não depende da variante do número); `participant` (add/promote/remove) prefere o JID de
   * telefone real. Entrada que não é telefone (LID, grupo) passa direto.
   */
  async resolve(session: string, phoneOrJid: string, purpose: ResolveFor = 'send'): Promise<ChatIdResolution> {
    const digits = phoneDigitsOf(phoneOrJid);
    if (!digits) return { jid: phoneOrJid, exists: true, via: 'passthrough' };
    const variants = phoneVariantsOf(digits);
    const key = variants[0]!;
    const canonicalJid = `${key}@c.us`;

    const hit = this.fresh(key);
    if (hit && (!hit.exists || hit.phoneJid || (purpose === 'send' && hit.lid)))
      return this.pick(hit, purpose, 'cache', canonicalJid);

    const entry: Entry = { ...hit, exists: true, at: this.now() };
    if (!entry.lid && this.opts.store?.byPhone) {
      try {
        const lid = (await this.opts.store.byPhone([`+${key}`])).get(`+${key}`);
        if (lid) entry.lid = lid;
      } catch {
        // store fora: segue p/ checkNumber
      }
      if (entry.lid && purpose === 'send') {
        this.put(key, entry);
        return this.pick(entry, purpose, 'store', canonicalJid);
      }
    }

    let checked = false;
    for (const v of variants) {
      let r: { exists: boolean; jid?: string; lid?: string };
      try {
        r = await this.engine.checkNumber(session, v);
      } catch {
        continue; // WAHA fora/lento: não bloqueia o envio
      }
      checked = true;
      if (!r.exists) continue;
      entry.phoneJid = r.jid && phoneDigitsOf(r.jid) ? r.jid.replace('@s.whatsapp.net', '@c.us') : `${v}@c.us`;
      if (r.lid && r.lid.endsWith('@lid')) {
        entry.lid = r.lid;
        await this.learn([{ lid: r.lid, phone: `+${key}` }]);
      }
      this.put(key, entry);
      return this.pick(entry, purpose, 'check', canonicalJid);
    }

    if (!checked) {
      // nada consultável: usa o que houver (LID do store ou canônico) sem cachear
      return entry.lid ? this.pick(entry, purpose, 'store', canonicalJid) : { jid: canonicalJid, exists: true, via: 'unchecked' };
    }
    if (entry.lid) {
      // checkNumber diz "não existe" mas o LID é conhecido (a pessoa entrou por grupo): LID vale
      this.put(key, entry);
      return this.pick(entry, purpose, 'store', canonicalJid);
    }
    this.put(key, { exists: false, at: this.now() });
    return { jid: canonicalJid, exists: false, via: 'check' };
  }

  private async learn(hints: LidHint[]) {
    try {
      await this.opts.store?.put(hints, 'checkNumber');
    } catch {
      // cache best-effort
    }
  }
}

const NO_LID = /no LID found/i;

/** Mapeia jids → destino resolvido; devolve PerJidResult no jid ORIGINAL (callers casam pelo que mandaram). */
async function participantsVia(
  resolver: ChatIdResolver,
  session: string,
  jids: string[],
  run: (resolved: string[]) => Promise<PerJidResult[]>,
): Promise<PerJidResult[]> {
  const rs = await Promise.all(jids.map((j) => resolver.resolve(session, j, 'participant')));
  const missing: PerJidResult[] = [];
  const back = new Map<string, string>();
  const targets: string[] = [];
  rs.forEach((r, i) => {
    const orig = jids[i]!;
    if (!r.exists) {
      missing.push({ jid: orig, ok: false, error: 'número sem WhatsApp' });
      return;
    }
    back.set(r.jid, orig);
    targets.push(r.jid);
  });
  const res = targets.length ? await run(targets) : [];
  const mapped = res.map((x) => ({ ...x, jid: back.get(x.jid) ?? x.jid }));
  // preserva a ordem de entrada
  const byJid = new Map([...mapped, ...missing].map((x) => [x.jid, x]));
  return jids.map((j) => byJid.get(j) ?? { jid: j, ok: true });
}

/**
 * Decorator: todo envio/participante por telefone passa pelo `ChatIdResolver` (envios, adição, promoção, remoção e
 * rebaixamento de participantes). Grupo/LID passam direto. Em `send`, `no LID found` invalida o
 * cache e tenta as outras variantes.
 */
export function withPhoneResolution<T extends WaEngine>(engine: T, resolver: ChatIdResolver): T {
  const send = async (name: string, chatId: string, block: MessageBlock, opts?: SendOptions) => {
    const digits = phoneDigitsOf(chatId);
    if (!digits) return engine.send(name, chatId, block, opts);
    const r = await resolver.resolve(name, chatId, 'send');
    if (!r.exists) throw new WaNumberNotFoundError(`+${phoneVariantsOf(digits)[0]}`);
    try {
      return await engine.send(name, r.jid, block, opts);
    } catch (err) {
      if (!(err instanceof WahaHttpError && NO_LID.test(err.body)) && !(err instanceof Error && NO_LID.test(err.message)))
        throw err;
      resolver.invalidate(chatId);
      for (const v of phoneVariantsOf(digits)) {
        const jid = `${v}@c.us`;
        if (jid === r.jid) continue;
        try {
          const ok = await engine.send(name, jid, block, opts);
          resolver.remember(chatId, jid);
          return ok;
        } catch (e2) {
          if (!(e2 instanceof Error && NO_LID.test(e2 instanceof WahaHttpError ? e2.body : e2.message))) throw e2;
        }
      }
      throw err;
    }
  };
  const part =
    (op: 'addParticipants' | 'removeParticipants' | 'promote' | 'demote') => (name: string, gid: string, jids: string[]) =>
      participantsVia(resolver, name, jids, (t) => engine[op](name, gid, t));
  const createGroup = async (name: string, input: { subject: string; participants: string[] }) => {
    const rs = await Promise.all(input.participants.map((j) => resolver.resolve(name, j, 'participant')));
    return engine.createGroup(name, { ...input, participants: rs.filter((r) => r.exists).map((r) => r.jid) });
  };
  const overrides: Partial<Record<keyof WaEngine, unknown>> = {
    send,
    createGroup,
    addParticipants: part('addParticipants'),
    removeParticipants: part('removeParticipants'),
    promote: part('promote'),
    demote: part('demote'),
  };
  return new Proxy(engine, {
    get(target, key, recv) {
      if (typeof key === 'string' && key in overrides) return overrides[key as keyof WaEngine];
      const v = Reflect.get(target, key, recv) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
