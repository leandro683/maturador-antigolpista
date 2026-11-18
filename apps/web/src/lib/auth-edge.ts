/**
 * Pedaços de auth que rodam também no middleware (Edge): só Web Crypto, sem node:crypto nem next/headers.
 * Cookie de sessão do modo `password` = `<exp>.<hmacSHA256(exp, SESSION_SECRET)>` (exp em segundos Unix).
 */

export const SESSION_COOKIE = 'mag_session';
export const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;
export const MIN_SECRET_LEN = 32;

const enc = new TextEncoder();

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparação sem atalho: só o tamanho (público) sai cedo; o resto percorre tudo. */
function equalConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signSession(secret: string, nowMs = Date.now()): Promise<string> {
  const exp = String(Math.floor(nowMs / 1000) + SESSION_MAX_AGE_S);
  return `${exp}.${await hmacHex(secret, exp)}`;
}

/** Falha fechada: sem segredo (ou curto), cookie ausente, mal formado, adulterado ou expirado → false. */
export async function verifySession(
  value: string | undefined,
  secret: string | undefined,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!value || !secret || secret.length < MIN_SECRET_LEN) return false;
  const dot = value.indexOf('.');
  if (dot < 1) return false;
  const exp = value.slice(0, dot);
  if (!/^\d{1,12}$/.test(exp)) return false;
  const macOk = equalConstantTime(await hmacHex(secret, exp), value.slice(dot + 1));
  return macOk && Number(exp) * 1000 > nowMs;
}

/** Rotas sem sessão: entrar, verificação pública de colaboradores, aviso do WhatsApp (HMAC próprio) e estáticos. */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname.startsWith('/verificar/') ||
    pathname === '/api/wa/events' ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico'
  );
}

/**
 * Destino pós-login: só caminho do mesmo site, senão o padrão. O navegador apaga tab/quebra de linha de uma URL e
 * trata `\` como `/`, então o texto cru não vale: recusa `\`, controle e espaço, e confere o que o parser resolve.
 * Devolve o caminho já normalizado (`/.//x` vira `//x` ao resolver, por isso o teste final).
 */
export function safeNext(next: string | null | undefined, fallback = '/contas'): string {
  // eslint-disable-next-line no-control-regex -- recusar caracteres de controle é o objetivo
  if (!next || !next.startsWith('/') || next.startsWith('//') || /[\\\s\u0000-\u001f\u007f-\u009f]/.test(next)) return fallback;
  try {
    const u = new URL(next, 'http://painel.invalid');
    const path = u.pathname + u.search;
    return u.origin === 'http://painel.invalid' && !path.startsWith('//') ? path : fallback;
  } catch {
    return fallback;
  }
}

/** ADMIN_EMAILS: lista separada por vírgula; vazia → ninguém entra. */
function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export type SupabaseUserLike = { id: string; email?: string | null; email_confirmed_at?: string | null };

/** Modo `supabase`: só entra quem tem e-mail confirmado e listado em ADMIN_EMAILS (middleware, getSession e login). */
export function isAllowedSupabaseUser(user: SupabaseUserLike | null | undefined): boolean {
  return !!user && !!user.email_confirmed_at && !!user.email && adminEmails().includes(user.email.trim().toLowerCase());
}
