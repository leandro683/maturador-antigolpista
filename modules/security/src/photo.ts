/** Distância de Hamming (de 64 bits) até a qual a foto conta como "igual" à de referência. */
export const PHOTO_MATCH_DISTANCE = 10;

const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

/** dHash de 64 bits (hex de 16): cinza 9x8, bit = pixel > vizinho da direita. Imagem inválida → null. */
export async function photoHash(bytes: Uint8Array): Promise<string | null> {
  try {
    // import dinâmico: o binário nativo só carrega quando alguém calcula um hash (o build do web não o empacota nem o executa)
    const { default: sharp } = await import('sharp');
    const px = await sharp(bytes).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
    let bits = 0n;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) bits = (bits << 1n) | (px[y * 9 + x]! > px[y * 9 + x + 1]! ? 1n : 0n);
    return bits.toString(16).padStart(16, '0');
  } catch {
    return null;
  }
}

export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  for (; x; x >>= 1n) n += Number(x & 1n);
  return n;
}

/** Baixa a foto (5 s, máx 2 MB, só `image/*`). Qualquer falha → null: nunca derruba o handler nem remove ninguém. */
export async function fetchPhoto(url: string, fetchFn: typeof fetch = fetch): Promise<Uint8Array | null> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok || !(res.headers.get('content-type') ?? '').toLowerCase().startsWith('image/')) {
      void res.body?.cancel(); // descarta o corpo: não deixa a conexão pendurada
      return null;
    }
    if (!res.body) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } catch {
    return null;
  }
}
