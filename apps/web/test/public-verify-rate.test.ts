import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Security from '@mag/module-security';

let headersNow: Record<string, string> = {};
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => ({ get: (n: string) => headersNow[n] ?? null }) }));
vi.mock('@/server/db', () => ({ serverDb: () => ({}) }));
vi.mock('@mag/module-security', async (orig) => ({
  ...(await orig<typeof Security>()),
  publicVerify: async () => ({ status: 'nao_encontrado' }),
}));

const { trustedClientIp } = await import('@/server/client-ip');
const { checkPublicNumber } = await import('@/server/services/public-verify');
const h = (m: Record<string, string>) => ({ get: (n: string) => m[n] ?? null });

afterEach(() => vi.unstubAllEnvs());

describe('IP confiável da página pública', () => {
  it('sem TRUST_PROXY nenhum cabeçalho vale; com TRUST_PROXY=1 vale o último item do X-Forwarded-For', () => {
    vi.stubEnv('TRUST_PROXY', '');
    expect(trustedClientIp(h({ 'cf-connecting-ip': '10.0.0.1', 'x-forwarded-for': '10.0.0.2', 'x-real-ip': '10.0.0.3' }))).toBeNull();
    vi.stubEnv('TRUST_PROXY', '1');
    expect(trustedClientIp(h({ 'x-forwarded-for': '10.0.0.9, forjado' }))).toBeNull(); // último item não é IP
    expect(trustedClientIp(h({ 'x-forwarded-for': '10.5.5.5, 10.0.0.9' }))).toBe('10.0.0.9');
    expect(trustedClientIp(h({ 'x-real-ip': '10.0.0.8' }))).toBe('10.0.0.8');
    expect(trustedClientIp(h({ 'cf-connecting-ip': '10.0.0.1' }))).toBeNull(); // cabeçalho de CDN não é confiável: só x-forwarded-for e x-real-ip
    expect(trustedClientIp(h({}))).toBeNull();
  });

  it('sem proxy: trocar o IP a cada consulta não burla o limite (vale o teto de 120 por minuto da página)', async () => {
    vi.stubEnv('TRUST_PROXY', '');
    for (let i = 0; i < 120; i++) {
      headersNow = { 'cf-connecting-ip': `10.1.${Math.floor(i / 250)}.${i % 250}` };
      expect((await checkPublicNumber('pagina-a', '11999990000')).status).toBe('nao_encontrado');
    }
    headersNow = { 'cf-connecting-ip': '10.9.9.9' };
    expect(await checkPublicNumber('pagina-a', '11999990000')).toEqual({ status: 'limite' });
    expect((await checkPublicNumber('pagina-b', '11999990000')).status).toBe('nao_encontrado');
  });

  it('com proxy confiável: o IP anexado pelo proxy é limitado (10/min) mesmo com cabeçalho forjado na frente', async () => {
    vi.stubEnv('TRUST_PROXY', '1');
    for (let i = 0; i < 10; i++) {
      headersNow = { 'x-forwarded-for': `forjado-${i}, 10.2.2.2` };
      expect((await checkPublicNumber('pagina-c', '11999990000')).status).toBe('nao_encontrado');
    }
    headersNow = { 'x-forwarded-for': 'outro-forjado, 10.2.2.2' };
    expect(await checkPublicNumber('pagina-c', '11999990000')).toEqual({ status: 'limite' });
    headersNow = { 'x-forwarded-for': '10.3.3.3' };
    expect((await checkPublicNumber('pagina-c', '11999990000')).status).toBe('nao_encontrado');
  });
});
