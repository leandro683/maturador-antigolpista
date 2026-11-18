import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, isPublicPath, safeNext, signSession, verifySession } from '@/lib/auth-edge';
import { config as middlewareConfig } from '../middleware';
import { checkLoginAttempt, clientIp, resetLoginAttempts } from '../app/login/rate-limit';

const jar = vi.hoisted(() => ({ store: new Map<string, { value: string; opts?: Record<string, unknown> }>() }));
const sb = vi.hoisted(() => ({
  client: null as null | {
    auth: {
      getUser: () => Promise<{ data: { user: { id: string; email?: string; email_confirmed_at?: string } | null } }>;
      signInWithPassword: (c: { email: string; password: string }) => Promise<{
        data: { user: { id: string; email?: string; email_confirmed_at?: string } | null };
        error: unknown;
      }>;
      signOut: (o?: unknown) => Promise<unknown>;
    };
  },
}));

// cliente do @supabase/ssr usado pelo middleware: o usuário que o "Supabase" devolve em cada teste
const ssr = vi.hoisted(() => ({ user: null as null | { id: string; email?: string; email_confirmed_at?: string } }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: ssr.user } }) } }),
  createBrowserClient: () => ({}),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({
    get: (n: string) => (jar.store.has(n) ? { name: n, value: jar.store.get(n)!.value } : undefined),
    set: (n: string, value: string, opts?: Record<string, unknown>) => void jar.store.set(n, { value, opts }),
    delete: (n: string) => void jar.store.delete(n),
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServer: async () => sb.client }));

const SECRET = 's'.repeat(40);
const PASSWORD = 'senha-de-teste-123';
const DAY_MS = 24 * 60 * 60 * 1000;

function passwordEnv() {
  vi.stubEnv('AUTH_MODE', 'password');
  vi.stubEnv('ADMIN_EMAIL', 'alguem@example.com');
  vi.stubEnv('ADMIN_PASSWORD', PASSWORD);
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('APP_URL', 'http://localhost:3100');
}

async function auth() {
  vi.resetModules(); // getSession usa cache() e lê o ambiente: módulo novo a cada teste
  return import('@/lib/auth');
}

beforeEach(() => {
  jar.store.clear();
  sb.client = null;
});
afterEach(() => vi.unstubAllEnvs());

describe('cookie de sessão (modo password)', () => {
  beforeEach(passwordEnv);

  it('cookie válido aceita', async () => {
    jar.store.set(SESSION_COOKIE, { value: await signSession(SECRET) });
    const { getSession, ADMIN_ID } = await auth();
    expect(await getSession()).toEqual({ user: { id: ADMIN_ID, email: 'alguem@example.com' }, role: 'owner' });
  });

  it('expirado recusa', async () => {
    jar.store.set(SESSION_COOKIE, { value: await signSession(SECRET, Date.now() - 8 * DAY_MS) });
    const { getSession } = await auth();
    expect((await getSession()).user).toBeNull();
  });

  it('adulterado recusa (assinatura trocada, prazo esticado, segredo outro, lixo, vazio)', async () => {
    const good = await signSession(SECRET);
    const [exp, mac] = good.split('.') as [string, string];
    const flipped = `${mac.startsWith('a') ? 'b' : 'a'}${mac.slice(1)}`;
    const { getSession } = await auth();
    for (const bad of [
      `${exp}.${flipped}`,
      `${Number(exp) + 99999}.${mac}`,
      await signSession('outro-segredo-qualquer-com-mais-de-32-chars'),
      'lixo',
      '.abc',
      `${exp}.`,
      '',
    ]) {
      jar.store.set(SESSION_COOKIE, { value: bad });
      expect((await getSession()).user, bad).toBeNull();
    }
  });

  it('sem cookie recusa', async () => {
    const { getSession } = await auth();
    expect(await getSession()).toEqual({ user: null, role: null });
  });

  it('falha fechado: SESSION_SECRET curto ou ausente, ADMIN_PASSWORD curta ou ausente, ADMIN_EMAIL ausente', async () => {
    const short = 'x'.repeat(31);
    for (const [key, value] of [
      ['SESSION_SECRET', short],
      ['SESSION_SECRET', ''],
      ['ADMIN_PASSWORD', 'curta'],
      ['ADMIN_PASSWORD', ''],
      ['ADMIN_EMAIL', ''],
    ] as const) {
      passwordEnv();
      vi.stubEnv(key, value);
      jar.store.set(SESSION_COOKIE, { value: await signSession(key === 'SESSION_SECRET' ? short : SECRET) });
      const a = await auth();
      expect(a.authConfigError(), `${key}=${value}`).toMatch(/\S/);
      expect((await a.getSession()).user).toBeNull();
      await expect(a.login('alguem@example.com', PASSWORD)).rejects.toThrow(key);
      expect(jar.store.size).toBe(1); // só o cookie semeado: o login não gravou outro
    }
  });

  it('AUTH_MODE desconhecido falha fechado', async () => {
    vi.stubEnv('AUTH_MODE', 'qualquer');
    const a = await auth();
    expect(a.authConfigError()).toMatch(/AUTH_MODE/);
  });

  it('verifySession recusa segredo curto mesmo com assinatura correta', async () => {
    const short = 'x'.repeat(31);
    expect(await verifySession(await signSession(short), short)).toBe(false);
  });
});

describe('login (modo password)', () => {
  beforeEach(passwordEnv);

  it('senha certa grava o cookie httpOnly + sameSite=lax de 7 dias e abre a sessão', async () => {
    const a = await auth();
    expect(await a.login(' Alguem@Example.com ', PASSWORD)).toBe(true);
    const c = jar.store.get(SESSION_COOKIE)!;
    expect(c.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 7 * 86400, secure: false });
    expect(await verifySession(c.value, SECRET)).toBe(true);
    expect((await a.getSession()).user?.email).toBe('alguem@example.com');
  });

  it('cookie é secure quando APP_URL é https', async () => {
    vi.stubEnv('APP_URL', 'https://painel.example.com');
    const a = await auth();
    await a.login('alguem@example.com', PASSWORD);
    expect(jar.store.get(SESSION_COOKIE)!.opts).toMatchObject({ secure: true });
  });

  it('senha errada recusa e não grava cookie', async () => {
    const a = await auth();
    expect(await a.login('alguem@example.com', 'errada-errada')).toBe(false);
    expect(await a.login('alguem@example.com', '')).toBe(false);
    expect(jar.store.size).toBe(0);
  });

  it('e-mail errado recusa', async () => {
    const a = await auth();
    expect(await a.login('outro@example.com', PASSWORD)).toBe(false);
    expect(jar.store.size).toBe(0);
  });

  it('logout apaga o cookie; requireAdmin sem sessão manda para /login', async () => {
    const a = await auth();
    await a.login('alguem@example.com', PASSWORD);
    await a.logout();
    expect(jar.store.size).toBe(0);
    await expect(a.requireAdmin()).rejects.toThrow('REDIRECT:/login');
  });

  it('requireAdmin com sessão devolve o usuário', async () => {
    jar.store.set(SESSION_COOKIE, { value: await signSession(SECRET) });
    const a = await auth();
    expect(await a.requireAdmin()).toEqual({ id: a.ADMIN_ID, email: 'alguem@example.com' });
  });
});

describe('modo supabase (cliente simulado)', () => {
  const CONFIRMED = '2026-01-01T00:00:00Z';
  const fakeClient = (user: { id: string; email?: string; email_confirmed_at?: string } | null) => ({
    auth: {
      getUser: async () => ({ data: { user } }),
      signInWithPassword: async () => ({ data: { user }, error: user ? null : new Error('x') }),
      signOut: vi.fn(async () => ({})),
    },
  });
  beforeEach(() => {
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-de-teste');
  });

  it('e-mail na lista entra (sem distinguir caixa nem espaços)', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'outra@example.com, Alguem@Example.com');
    sb.client = fakeClient({ id: 'u1', email: 'alguem@example.com', email_confirmed_at: CONFIRMED });
    const a = await auth();
    expect(await a.getSession()).toEqual({ user: { id: 'u1', email: 'alguem@example.com' }, role: 'owner' });
  });

  it('e-mail fora da lista não entra', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'outra@example.com');
    sb.client = fakeClient({ id: 'u1', email: 'alguem@example.com', email_confirmed_at: CONFIRMED });
    const a = await auth();
    expect((await a.getSession()).user).toBeNull();
  });

  it('lista vazia ou ausente: ninguém entra', async () => {
    sb.client = fakeClient({ id: 'u1', email: 'alguem@example.com', email_confirmed_at: CONFIRMED });
    for (const v of ['', ' , ,']) {
      vi.stubEnv('ADMIN_EMAILS', v);
      const a = await auth();
      expect((await a.getSession()).user).toBeNull();
    }
  });

  it('sem usuário logado ou sem cliente configurado não entra', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'alguem@example.com');
    sb.client = fakeClient(null);
    expect((await (await auth()).getSession()).user).toBeNull();
    sb.client = null;
    expect((await (await auth()).getSession()).user).toBeNull();
  });

  it('e-mail na lista mas NÃO confirmado: não entra (getSession) e o login é recusado com sessão encerrada', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'alguem@example.com');
    for (const email_confirmed_at of [undefined, '']) {
      sb.client = fakeClient({ id: 'u1', email: 'alguem@example.com', email_confirmed_at });
      const a = await auth();
      expect((await a.getSession()).user).toBeNull();
      expect(await a.login('alguem@example.com', 'x')).toBe(false);
      expect(sb.client.auth.signOut).toHaveBeenCalled();
    }
  });

  it('login: e-mail fora da lista é recusado e a sessão Supabase é encerrada', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'outra@example.com');
    sb.client = fakeClient({ id: 'u1', email: 'alguem@example.com', email_confirmed_at: CONFIRMED });
    const a = await auth();
    expect(await a.login('alguem@example.com', 'x')).toBe(false);
    expect(sb.client.auth.signOut).toHaveBeenCalled();
  });

  it('login: e-mail na lista entra; senha errada não', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'alguem@example.com');
    sb.client = fakeClient({ id: 'u1', email: 'alguem@example.com', email_confirmed_at: CONFIRMED });
    expect(await (await auth()).login('alguem@example.com', 'x')).toBe(true);
    sb.client = fakeClient(null);
    expect(await (await auth()).login('alguem@example.com', 'x')).toBe(false);
  });
});

describe('middleware', () => {
  async function run(path: string, cookie?: string) {
    vi.resetModules();
    const { middleware } = await import('../middleware');
    return middleware(new NextRequest(`http://painel.test${path}`, { headers: cookie ? { cookie } : {} }));
  }
  beforeEach(passwordEnv);

  it('sem cookie: página vai para /login com ?next, API recebe 401', async () => {
    const page = await run('/contas?x=1');
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toBe('http://painel.test/login?next=%2Fcontas%3Fx%3D1');
    expect((await run('/api/actions')).status).toBe(401);
  });

  it('cookie válido passa; adulterado não', async () => {
    const good = await signSession(SECRET);
    expect((await run('/contas', `${SESSION_COOKIE}=${good}`)).headers.get('x-middleware-next')).toBe('1');
    const bad = `${good.slice(0, -1)}${good.endsWith('0') ? '1' : '0'}`;
    expect((await run('/contas', `${SESSION_COOKIE}=${bad}`)).status).toBe(307);
  });

  it('sem SESSION_SECRET nem cookie válido entra', async () => {
    const good = await signSession(SECRET);
    vi.stubEnv('SESSION_SECRET', '');
    expect((await run('/contas', `${SESSION_COOKIE}=${good}`)).status).toBe(307);
  });

  it('rotas públicas passam sem cookie', async () => {
    for (const p of ['/login', '/verificar/abc', '/api/wa/events']) {
      expect((await run(p)).headers.get('x-middleware-next'), p).toBe('1');
    }
  });

  describe('modo supabase (cliente simulado)', () => {
    const CONFIRMED = '2026-01-01T00:00:00Z';
    beforeEach(() => {
      vi.stubEnv('AUTH_MODE', 'supabase');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-de-teste');
      vi.stubEnv('ADMIN_EMAILS', 'outra@example.com, Alguem@Example.com');
      ssr.user = null;
    });

    it('e-mail confirmado e na lista passa', async () => {
      ssr.user = { id: 'u1', email: 'alguem@example.com', email_confirmed_at: CONFIRMED };
      expect((await run('/contas')).headers.get('x-middleware-next')).toBe('1');
      expect((await run('/api/actions')).headers.get('x-middleware-next')).toBe('1');
    });

    it('qualquer conta Supabase fora da lista é barrada (página → /login, API → 401)', async () => {
      ssr.user = { id: 'u2', email: 'intruso@example.com', email_confirmed_at: CONFIRMED };
      expect((await run('/contas')).status).toBe(307);
      expect((await run('/api/actions')).status).toBe(401);
    });

    it('e-mail na lista mas não confirmado é barrado', async () => {
      ssr.user = { id: 'u1', email: 'alguem@example.com' };
      expect((await run('/contas')).status).toBe(307);
      expect((await run('/api/actions')).status).toBe(401);
    });

    it('sem usuário ou lista vazia: barrado; rota pública passa mesmo assim', async () => {
      expect((await run('/contas')).status).toBe(307);
      ssr.user = { id: 'u1', email: 'alguem@example.com', email_confirmed_at: CONFIRMED };
      vi.stubEnv('ADMIN_EMAILS', '');
      expect((await run('/contas')).status).toBe(307);
      expect((await run('/login')).headers.get('x-middleware-next')).toBe('1');
    });
  });
});

describe('matcher do middleware', () => {
  const matches = (path: string) => new RegExp(`^${middlewareConfig.matcher[0]}$`).test(path);

  it('pula só os estáticos do próprio Next', () => {
    for (const p of ['/_next/static/chunks/a.js', '/_next/image', '/favicon.ico'])
      expect(matches(p), p).toBe(false);
  });

  it('nunca pula por extensão: rota que termina em imagem passa pelo porteiro', () => {
    for (const p of ['/', '/contas', '/api/contas/abc/qr.png', '/api/grupos/x.svg', '/a/b.jpg', '/x.webp', '/favicon.icon', '/_next/staticx'])
      expect(matches(p), p).toBe(true);
  });
});

describe('rotas públicas e destino pós-login', () => {
  it('lista exata', () => {
    for (const p of ['/login', '/verificar/x', '/api/wa/events', '/_next/static/a.js', '/favicon.ico'])
      expect(isPublicPath(p), p).toBe(true);
    for (const p of ['/', '/contas', '/api/wa', '/api/wa/events/x', '/api/actions', '/verificar', '/login/x', '/sair'])
      expect(isPublicPath(p), p).toBe(false);
  });

  it('safeNext só aceita caminho do mesmo site', () => {
    expect(safeNext('/maturador?a=1')).toBe('/maturador?a=1');
    expect(safeNext('/a//b')).toBe('/a//b');
    for (const bad of [
      '//evil.example',
      'https://evil.example',
      '/\\evil',
      '/\\/evil.example',
      '',
      undefined,
      null,
      // o navegador apaga tab e quebra de linha: "/\t/evil.example" vira "//evil.example"
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r/evil.example',
      '/ /evil.example',
      '/ /evil.example',
      '/\u0000/evil.example',
      '/\u007f/evil.example',
      '/\u0085/evil.example',
      '/x\ty',
      // o parser resolve estes para "//evil": só o caminho já normalizado revela
      '/.//evil.example',
      '/%2e//evil.example',
      '/a/../..//evil.example',
      'javascript:alert(1)',
      'evil.example',
    ])
      expect(safeNext(bad), JSON.stringify(bad)).toBe('/contas');
  });

  it('safeNext decodifica como o ?next= real: /login?next=/%09/evil cai no padrão', () => {
    const next = new URL('http://painel.test/login?next=/%09/evil.example').searchParams.get('next');
    expect(next).toBe('/\t/evil.example');
    expect(safeNext(next)).toBe('/contas');
  });
});

describe('entrar (server action)', () => {
  beforeEach(passwordEnv);

  it('senha certa devolve o destino em vez de redirect() (o redirect do action perde o cookie novo e quebra no navegador)', async () => {
    const { entrar } = await import('../app/login/actions');
    const form = (senha: string) => {
      const f = new FormData();
      f.set('email', 'alguem@example.com');
      f.set('senha', senha);
      f.set('next', '/seguranca');
      return f;
    };
    expect(await entrar({}, form(PASSWORD))).toEqual({ destino: '/seguranca' });
    expect(jar.store.has(SESSION_COOKIE)).toBe(true);
    jar.store.clear();
    expect(await entrar({}, form('errada-errada-123'))).toEqual({ erro: 'E-mail ou senha inválidos.' });
    expect(jar.store.has(SESSION_COOKIE)).toBe(false);
    resetLoginAttempts('global');
  });
});

describe('limite de tentativas de entrar', () => {
  it('5 por IP em 15 min; a 6ª é barrada; janela nova libera; sucesso zera; IPs independentes', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(checkLoginAttempt('10.0.0.1', t0 + i).ok).toBe(true);
    const blocked = checkLoginAttempt('10.0.0.1', t0 + 10);
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.retryAfterS).toBeGreaterThan(14 * 60);
    expect(checkLoginAttempt('10.0.0.2', t0 + 10).ok).toBe(true);
    expect(checkLoginAttempt('10.0.0.1', t0 + 15 * 60 * 1000 + 1).ok).toBe(true);
    for (let i = 0; i < 3; i++) checkLoginAttempt('10.0.0.3', t0);
    resetLoginAttempts('10.0.0.3');
    for (let i = 0; i < 5; i++) expect(checkLoginAttempt('10.0.0.3', t0).ok).toBe(true);
  });

  const h = (m: Record<string, string>) => ({ get: (n: string) => m[n] ?? null });

  it('sem TRUST_PROXY: cabeçalhos são ignorados, balde global único (forjar X-Forwarded-For não burla o limite)', () => {
    vi.stubEnv('TRUST_PROXY', '');
    const cases: Record<string, string>[] = [{}, { 'x-forwarded-for': 'forjado, 10.0.0.9' }, { 'x-real-ip': '10.0.0.8' }, { 'x-forwarded-for': '10.0.0.50' }];
    for (const headers of cases)
      expect(clientIp(h(headers))).toBe('global');
    vi.stubEnv('TRUST_PROXY', '0');
    expect(clientIp(h({ 'x-forwarded-for': '10.0.0.50' }))).toBe('global');
    // atacante troca o cabeçalho a cada tentativa: continua tudo no mesmo balde, a 6ª é barrada
    const t0 = 5_000_000;
    vi.stubEnv('TRUST_PROXY', '');
    for (let i = 0; i < 5; i++) expect(checkLoginAttempt(clientIp(h({ 'x-forwarded-for': `10.0.9.${i}` })), t0).ok).toBe(true);
    expect(checkLoginAttempt(clientIp(h({ 'x-forwarded-for': '10.0.9.99' })), t0).ok).toBe(false);
    resetLoginAttempts('global');
  });

  it('com TRUST_PROXY=1: IP vem do fim do X-Forwarded-For (o que o proxy anexou); baldes por IP', () => {
    vi.stubEnv('TRUST_PROXY', '1');
    expect(clientIp(h({ 'x-forwarded-for': 'forjado, 10.0.0.9' }))).toBe('10.0.0.9');
    expect(clientIp(h({ 'x-real-ip': '10.0.0.8' }))).toBe('10.0.0.8');
    expect(clientIp(h({}))).toBe('desconhecido');
    const t0 = 6_000_000;
    for (let i = 0; i < 6; i++) checkLoginAttempt(clientIp(h({ 'x-forwarded-for': '10.0.0.41' })), t0);
    expect(checkLoginAttempt(clientIp(h({ 'x-forwarded-for': '10.0.0.41' })), t0).ok).toBe(false);
    expect(checkLoginAttempt(clientIp(h({ 'x-forwarded-for': '10.0.0.42' })), t0).ok).toBe(true);
  });
});
