import { createHmac, timingSafeEqual } from 'node:crypto';

export type HmacAlgorithm = 'sha256' | 'sha512';

/** HMAC hex. sha256: edge→origin e webhooks (X-Signature). WAHA assina com sha512 (X-Webhook-Hmac). */
export function signHmac(body: string, secret: string, algorithm: HmacAlgorithm = 'sha256'): string {
  return createHmac(algorithm, secret).update(body).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Aceita `hex` puro ou `<algo>=hex`. */
export function verifyHmac(
  body: string,
  secret: string,
  signature: string | null | undefined,
  algorithm: HmacAlgorithm = 'sha256',
): boolean {
  if (!signature || !secret) return false;
  const eq = signature.indexOf('=');
  const sig = eq > 0 && /^sha\d+$/.test(signature.slice(0, eq)) ? signature.slice(eq + 1) : signature;
  return safeEqual(sig.toLowerCase(), signHmac(body, secret, algorithm));
}
