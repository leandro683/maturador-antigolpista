import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Anti-impostor (painel): as duas ações só devolvem o hash da foto de referência. Arquivo inválido → erro em
 * português; número sem foto visível ou campanha sem conta conectada → erro claro. Sem rede e sem banco: motor,
 * `fetch` e `serverDb` são falsos.
 */

const CAMPAIGN = '11111111-1111-4111-8111-111111111111';
const getProfilePicture = vi.fn();
const dbResults: unknown[][] = [];

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  getSession: async () => ({ user: { id: 'u1' }, role: 'owner' }),
  requireAdmin: async () => ({ id: 'u1' }),
}));
vi.mock('@/server/db', () => ({
  // cada `await db.select()…` consome o próximo resultado da fila
  serverDb: () => ({
    select() {
      const q: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'limit', 'orderBy']) q[m] = () => q;
      q.then = (res: (v: unknown) => unknown) => res(dbResults.shift() ?? []);
      return q;
    },
  }),
}));
vi.mock('@/server/engine', () => ({ serverEngine: () => ({ getProfilePicture }) }));
vi.mock('@/server/queues', () => ({ serverQueue: vi.fn() }));
vi.mock('@mag/module-security', async (orig) => ({
  ...(await orig<object>()),
  phoneResolvingEngine: <T>(e: T) => e,
}));

const { impersonationPhotoFromFile, impersonationPhotoFromNumber } = await import('../src/server/services/security');

// `sharp` é dependência do módulo de segurança (não do web): resolve a partir dele
type Sharp = (raw: Buffer, o: { raw: { width: number; height: number; channels: number } }) => Record<'png' | 'jpeg' | 'webp', () => { toBuffer(): Promise<Buffer> }>;
const sharp = createRequire(new URL('../../../modules/security/package.json', import.meta.url))('sharp') as Sharp;

/** Degradê com ruído determinístico: o hash não fica zerado. */
async function image(format: 'png' | 'jpeg' | 'webp' = 'png') {
  const raw = Buffer.alloc(32 * 32 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 37 + (i % 7) * 11) % 256;
  return new Uint8Array(await sharp(raw, { raw: { width: 32, height: 32, channels: 3 } })[format]().toBuffer());
}

const form = (bytes: Uint8Array, name: string, type: string) => {
  const f = new FormData();
  f.append('file', new File([bytes as BlobPart], name, { type }));
  return f;
};

const campaignRows = (...status: string[]) => {
  dbResults.push([{ ids: ['a1', 'a2'] }]);
  dbResults.push(status.map((s, i) => ({ sessionName: `s${i + 1}`, status: s })));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  dbResults.length = 0;
});

describe('impersonationPhotoFromFile', () => {
  it('imagem válida → hash de 16 hex (png, jpeg e webp)', async () => {
    for (const [fmt, type] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']] as const) {
      const r = await impersonationPhotoFromFile(form(await image(fmt), `a.${fmt}`, type));
      expect(r.ok && r.data.hash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('sem arquivo, tipo fora de png/jpeg/webp e acima de 1 MB → erro', async () => {
    expect(await impersonationPhotoFromFile(new FormData())).toEqual({ ok: false, error: 'Escolha uma imagem.' });
    expect(await impersonationPhotoFromFile(form(new Uint8Array([1, 2, 3]), 'a.gif', 'image/gif'))).toEqual({
      ok: false,
      error: 'Use uma imagem PNG, JPG ou WebP.',
    });
    expect(await impersonationPhotoFromFile(form(new Uint8Array(1024 * 1024 + 1), 'a.png', 'image/png'))).toEqual({
      ok: false,
      error: 'A imagem passa de 1 MB.',
    });
  });

  it('arquivo com cara de imagem mas que não decodifica → erro', async () => {
    const r = await impersonationPhotoFromFile(form(new TextEncoder().encode('não sou imagem'), 'a.png', 'image/png'));
    expect(r).toEqual({ ok: false, error: 'Não consegui ler essa imagem. Tente outro arquivo.' });
  });
});

describe('impersonationPhotoFromNumber', () => {
  it('pega a foto na primeira conta conectada e devolve o hash', async () => {
    campaignRows('disconnected', 'connected');
    getProfilePicture.mockResolvedValue('https://pps.whatsapp.net/foto.jpg');
    const bytes = await image('jpeg');
    vi.stubGlobal('fetch', async () => new Response(bytes as BodyInit, { headers: { 'content-type': 'image/jpeg' } }));
    const r = await impersonationPhotoFromNumber(CAMPAIGN, '+55 11 99999-0011');
    expect(r.ok && r.data.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(getProfilePicture).toHaveBeenCalledWith('s2', '5511999990011@c.us');
  });

  it('número sem foto visível → erro', async () => {
    campaignRows('connected');
    getProfilePicture.mockResolvedValue(null);
    expect(await impersonationPhotoFromNumber(CAMPAIGN, '11999990011')).toEqual({
      ok: false,
      error: 'Esse número não tem foto visível.',
    });
  });

  it('URL que não devolve imagem também conta como sem foto', async () => {
    campaignRows('active');
    getProfilePicture.mockResolvedValue('https://pps.whatsapp.net/foto.jpg');
    vi.stubGlobal('fetch', async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }));
    const r = await impersonationPhotoFromNumber(CAMPAIGN, '11999990011');
    expect(r).toEqual({ ok: false, error: 'Esse número não tem foto visível.' });
  });

  it('sem conta conectada na operação → erro, sem consultar o WhatsApp', async () => {
    campaignRows('disconnected', 'needs_reauth');
    expect(await impersonationPhotoFromNumber(CAMPAIGN, '11999990011')).toEqual({
      ok: false,
      error: 'Nenhuma conta conectada nesta operação.',
    });
    expect(getProfilePicture).not.toHaveBeenCalled();
  });

  it('número inválido → erro', async () => {
    expect(await impersonationPhotoFromNumber(CAMPAIGN, 'abc')).toEqual({ ok: false, error: 'Número inválido.' });
  });
});
