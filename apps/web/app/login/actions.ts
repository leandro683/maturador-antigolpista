'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { authConfigError, login, logout } from '@/lib/auth';
import { safeNext } from '@/lib/auth-edge';
import { checkLoginAttempt, clientIp, resetLoginAttempts } from './rate-limit';

export type LoginState = { erro?: string; destino?: string };

/** Server action do formulário de entrar (modo password e supabase). Nunca registra e-mail nem senha. */
export async function entrar(_prev: LoginState, form: FormData): Promise<LoginState> {
  const config = authConfigError();
  if (config) return { erro: config };
  const ip = clientIp(await headers());
  const gate = checkLoginAttempt(ip);
  if (!gate.ok) return { erro: `Muitas tentativas. Tente de novo em ${Math.ceil(gate.retryAfterS / 60)} min.` };
  let ok = false;
  try {
    ok = await login(String(form.get('email') ?? ''), String(form.get('senha') ?? ''));
  } catch {
    return { erro: 'Não foi possível entrar agora. Tente de novo.' };
  }
  if (!ok) return { erro: 'E-mail ou senha inválidos.' };
  resetLoginAttempts(ip);
  // não usa redirect(): o Next refaz a busca do destino sem o cookie recém-gravado, o middleware manda de volta a /login
  // e o navegador recebe "resposta inesperada"; o cliente navega por conta própria (carga completa, já com o cookie)
  return { destino: safeNext(String(form.get('next') ?? '')) };
}

/** Botão "Sair" do painel. */
export async function sair(): Promise<void> {
  await logout();
  redirect('/login');
}
