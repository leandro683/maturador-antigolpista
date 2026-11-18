// shortcut: limite em memória, trocar por Redis com mais de uma réplica
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

const hits = new Map<string, { n: number; resetAt: number }>();

/** Conta uma tentativa de entrar deste IP; `ok: false` quando passou de 5 na janela de 15 min. */
export function checkLoginAttempt(ip: string, now = Date.now()): { ok: true } | { ok: false; retryAfterS: number } {
  for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k); // poda: o mapa não cresce sem limite
  const cur = hits.get(ip);
  const entry = cur && cur.resetAt > now ? cur : { n: 0, resetAt: now + WINDOW_MS };
  entry.n += 1;
  hits.set(ip, entry);
  return entry.n <= MAX_ATTEMPTS ? { ok: true } : { ok: false, retryAfterS: Math.ceil((entry.resetAt - now) / 1000) };
}

/** Entrou: zera o contador do IP. */
export function resetLoginAttempts(ip: string): void {
  hits.delete(ip);
}

/**
 * Chave do limite de tentativas. Sem proxy o cliente escolhe o X-Forwarded-For, então o cabeçalho é ignorado e todos
 * dividem um balde só. Com TRUST_PROXY=1 (proxy que sobrescreve o cabeçalho) ele ANEXA o IP real ao fim: vale o último item.
 * shortcut: balde global sem proxy confiável (qualquer um que erre 5 vezes trava o dono por 15 min), por IP com TRUST_PROXY=1.
 */
export function clientIp(h: { get(name: string): string | null }): string {
  if (process.env.TRUST_PROXY !== '1') return 'global';
  const xff = h.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  return xff || h.get('x-real-ip')?.trim() || 'desconhecido';
}
