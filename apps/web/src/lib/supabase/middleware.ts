import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseUserLike } from '../auth-edge';
import { supabaseEnv } from './env';

/** Renova a sessão Supabase (refresh de cookie) e devolve a resposta com os cookies novos + o usuário (ou null). */
export async function updateSupabaseSession(
  req: NextRequest,
): Promise<{ res: NextResponse; user: SupabaseUserLike | null }> {
  let res = NextResponse.next({ request: req });
  const env = supabaseEnv();
  if (!env) return { res, user: null };
  const sb = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) req.cookies.set(name, value);
        res = NextResponse.next({ request: req });
        for (const { name, value, options } of list) res.cookies.set(name, value, options);
      },
    },
  });
  const { data } = await sb.auth.getUser();
  return { res, user: data.user };
}
