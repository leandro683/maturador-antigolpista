import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, isAllowedSupabaseUser, isPublicPath, verifySession } from '@/lib/auth-edge';
import { updateSupabaseSession } from '@/lib/supabase/middleware';

/**
 * Porta de entrada: sem sessão só passam as rotas públicas. Modo `supabase` renova a sessão e exige e-mail confirmado
 * em ADMIN_EMAILS (qualquer um pode criar conta no Supabase); modo `password` confere o cookie assinado.
 * Cada route handler e server action ainda chama requireAdmin(): o middleware não cobre ação postada em rota pública.
 */
export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  let res = NextResponse.next();
  let signedIn: boolean;
  if (process.env.AUTH_MODE === 'supabase') {
    const r = await updateSupabaseSession(req);
    res = r.res;
    signedIn = isAllowedSupabaseUser(r.user);
  } else {
    signedIn = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET);
  }
  if (signedIn || isPublicPath(path)) return res;
  if (path.startsWith('/api/')) return NextResponse.json({ error: 'não autenticado' }, { status: 401 });
  const to = req.nextUrl.clone();
  to.pathname = '/login';
  to.search = '';
  to.searchParams.set('next', path + req.nextUrl.search);
  return NextResponse.redirect(to);
}

// Só os estáticos do próprio Next ficam de fora; nunca por extensão (`/api/.../qr.png` precisa passar pelo porteiro).
export const config = {
  matcher: ['/((?!_next/static/|_next/image$|favicon\\.ico$).*)'],
};
