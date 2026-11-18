import { describe, expect, it } from 'vitest';
import { signHmac, verifyHmac } from '../src/hmac';

describe('hmac', () => {
  it('assina e verifica (com ou sem prefixo sha256=)', () => {
    const sig = signHmac('{"a":1}', 's3cr3t');
    expect(verifyHmac('{"a":1}', 's3cr3t', sig)).toBe(true);
    expect(verifyHmac('{"a":1}', 's3cr3t', `sha256=${sig}`)).toBe(true);
    expect(verifyHmac('{"a":2}', 's3cr3t', sig)).toBe(false);
    expect(verifyHmac('{"a":1}', 's3cr3t', null)).toBe(false);
    expect(verifyHmac('{"a":1}', '', sig)).toBe(false);
  });
});
