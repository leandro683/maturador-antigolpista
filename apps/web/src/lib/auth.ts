import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import {
  MIN_SECRET_LEN,
  SESSION_COOKIE,
  isAllowedSupabaseUser,
  SESSION_MAX_AGE_S,
  signSession,
  verifySession,
} from '@/lib/auth-edge';
import { supabaseEnv } from '@/lib/supabase/env';
import { createSupabaseServer } from '@/lib/supabase/server';

/** Painel de um dono só: no modo `password` o id é fixo. */
export const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const MIN_PASSWORD_LEN = 10;

type AdminUser = { id: string; email?: string };
export type Session = { user: AdminUser | null; role: 'owner' | null };
const ANON: Session = { user: null, role: null };

export type AuthMode = 'password' | 'supabase';
export const authMode = (): AuthMode => (process.env.AUTH_MODE === 'supabase' ? 'supabase' : 'password');

/** Problema de configuração (texto seguro p/ mostrar na tela; nunca inclui valores). null = ok. Quem usa falha fechado. */
export function authConfigError(): string | null {
  const mode = process.env.AUTH_MODE;
  if (mode && mode !== 'password' && mode !== 'supabase') return 'AUTH_MODE deve ser "password" ou "supabase".';
  if (authMode() === 'supabase')
    return supabaseEnv() ? null : 'Defina NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY (AUTH_MODE=supabase).';
  if (!process.env.ADMIN_EMAIL?.trim()) return 'Defina ADMIN_EMAIL.';
  if ((process.env.ADMIN_PASSWORD ?? '').length < MIN_PASSWORD_LEN)
    return `ADMIN_PASSWORD ausente ou curta demais (mínimo ${MIN_PASSWORD_LEN} caracteres).`;
  if ((process.env.SESSION_SECRET ?? '').length < MIN_SECRET_LEN)
    return `SESSION_SECRET ausente ou curto demais (mínimo ${MIN_SECRET_LEN} caracteres).`;
  return null;
}

/** SHA-256 dos dois lados: tamanhos iguais p/ o timingSafeEqual e nada do tamanho do segredo vaza. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** `secure` só com APP_URL em https (em http local o navegador descartaria o cookie). */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: (process.env.APP_URL ?? '').startsWith('https://'),
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
  };
}

export const getSession = cache(async (): Promise<Session> => {
  if (authConfigError()) return ANON;
  if (authMode() === 'supabase') {
    const sb = await createSupabaseServer();
    if (!sb) return ANON;
    const { user } = (await sb.auth.getUser()).data;
    if (!user || !isAllowedSupabaseUser(user)) return ANON;
    return { user: { id: user.id, email: user.email }, role: 'owner' };
  }
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await verifySession(value, process.env.SESSION_SECRET))) return ANON;
  return { user: { id: ADMIN_ID, email: process.env.ADMIN_EMAIL }, role: 'owner' };
});

/** Página/ação só do dono: sem sessão válida vai para /login. */
export async function requireAdmin(): Promise<AdminUser> {
  const { user } = await getSession();
  if (!user) redirect('/login');
  return user;
}

/** true = entrou (cookie gravado / sessão Supabase aberta). Lança só se a configuração for inválida. */
export async function login(email: string, password: string): Promise<boolean> {
  const config = authConfigError();
  if (config) throw new Error(config);
  if (authMode() === 'supabase') {
    const sb = await createSupabaseServer();
    if (!sb) return false;
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error || !data.user) return false;
    if (isAllowedSupabaseUser(data.user)) return true;
    await sb.auth.signOut({ scope: 'local' }); // autenticou, mas não está em ADMIN_EMAILS ou não confirmou o e-mail
    return false;
  }
  // os dois lados sempre são comparados (sem curto-circuito): o tempo não diz qual deles errou
  const emailOk = safeEqual(email.trim().toLowerCase(), process.env.ADMIN_EMAIL!.trim().toLowerCase());
  const passwordOk = safeEqual(password, process.env.ADMIN_PASSWORD!);
  if (!emailOk || !passwordOk) return false;
  (await cookies()).set(SESSION_COOKIE, await signSession(process.env.SESSION_SECRET!), sessionCookieOptions());
  return true;
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  if (authMode() === 'supabase') await (await createSupabaseServer())?.auth.signOut({ scope: 'local' });
}
