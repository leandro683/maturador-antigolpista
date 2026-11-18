import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { fetchPhoto, hamming, photoHash, PHOTO_MATCH_DISTANCE } from '../src/photo';

/** Imagem sintética determinística: blocos de tons pseudo-aleatórios (LCG), sem depender de arquivo. */
async function base(invert = false): Promise<Buffer> {
  const size = 256;
  const block = 16;
  const px = Buffer.alloc(size * size * 3);
  let s = 12345;
  const tones: number[] = [];
  for (let i = 0; i < (size / block) ** 2; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    tones.push(s % 256);
  }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const t = tones[Math.floor(y / block) * (size / block) + Math.floor(x / block)]!;
      const v = invert ? 255 - t : t;
      const o = (y * size + x) * 3;
      px[o] = v;
      px[o + 1] = v;
      px[o + 2] = v;
    }
  return sharp(px, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

describe('photoHash', () => {
  it('hash de 16 hex; versão reescalada e recomprimida fica perto', async () => {
    const orig = await photoHash(await base());
    const small = await sharp(await base()).resize(96, 96).jpeg({ quality: 60 }).toBuffer();
    const copy = await photoHash(small);
    expect(orig).toMatch(/^[0-9a-f]{16}$/);
    expect(hamming(orig!, copy!)).toBeLessThanOrEqual(PHOTO_MATCH_DISTANCE);
  });

  it('imagem diferente (invertida) fica longe', async () => {
    const a = await photoHash(await base());
    const b = await photoHash(await base(true));
    expect(hamming(a!, b!)).toBeGreaterThan(PHOTO_MATCH_DISTANCE);
  });

  it('bytes aleatórios -> null', async () => {
    expect(await photoHash(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });

  it('sharp que não carrega (binário ausente): importar photo.ts não quebra e photoHash devolve null', async () => {
    vi.resetModules();
    vi.doMock('sharp', () => {
      throw new Error('Could not load the sharp module using the linux-x64 runtime');
    });
    try {
      const mod = await import('../src/photo');
      expect(await mod.photoHash(new Uint8Array([1, 2, 3]))).toBeNull();
    } finally {
      vi.doUnmock('sharp');
      vi.resetModules();
    }
  });
});

describe('hamming', () => {
  it('conta bits diferentes', () => {
    expect(hamming('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hamming('0000000000000001', '0000000000000003')).toBe(1);
  });
});

describe('fetchPhoto', () => {
  const resp = (body: Uint8Array | string, type: string) =>
    (async () => new Response(body as BodyInit, { headers: { 'content-type': type } })) as unknown as typeof fetch;

  it('imagem válida -> bytes', async () => {
    const out = await fetchPhoto('http://x/a.png', resp(new Uint8Array([1, 2, 3]), 'image/png'));
    expect(out).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('text/html -> null', async () => {
    expect(await fetchPhoto('http://x', resp('<html></html>', 'text/html'))).toBeNull();
  });

  it('corpo de 3 MB -> null', async () => {
    expect(await fetchPhoto('http://x', resp(new Uint8Array(3 * 1024 * 1024), 'image/jpeg'))).toBeNull();
  });

  it('rejeição e HTTP de erro -> null', async () => {
    const boom = (async () => {
      throw new Error('rede');
    }) as unknown as typeof fetch;
    expect(await fetchPhoto('http://x', boom)).toBeNull();
    const nok = (async () => new Response('x', { status: 404, headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch;
    expect(await fetchPhoto('http://x', nok)).toBeNull();
  });

  it('resposta descartada (HTTP de erro ou não-imagem): o corpo é cancelado, não fica pendurado', async () => {
    const withBody = (status: number, type: string) => {
      let cancelled = false;
      const body = new ReadableStream({
        pull: (c) => c.enqueue(new Uint8Array([1])),
        cancel: () => void (cancelled = true),
      });
      const f = (async () => new Response(body, { status, headers: { 'content-type': type } })) as unknown as typeof fetch;
      return { f, cancelled: () => cancelled };
    };
    const nok = withBody(404, 'image/png');
    expect(await fetchPhoto('http://x', nok.f)).toBeNull();
    expect(nok.cancelled()).toBe(true);
    const html = withBody(200, 'text/html');
    expect(await fetchPhoto('http://x', html.f)).toBeNull();
    expect(html.cancelled()).toBe(true);
  });
});
