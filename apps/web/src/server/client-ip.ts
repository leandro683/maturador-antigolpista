/**
 * IP do cliente só quando dá para confiar nele. Sem proxy o visitante escolhe `X-Forwarded-For`/`CF-Connecting-IP`,
 * então os cabeçalhos são ignorados (`null`). Com TRUST_PROXY=1 (proxy que sobrescreve o cabeçalho) ele ANEXA o IP real
 * ao fim: vale o último item de `X-Forwarded-For`.
 */
export function trustedClientIp(h: { get(name: string): string | null }): string | null {
  if (process.env.TRUST_PROXY !== '1') return null;
  const ip = (h.get('x-forwarded-for')?.split(',').at(-1) ?? h.get('x-real-ip') ?? '').trim();
  return /^[0-9a-f.:]+$/i.test(ip) ? ip : null;
}
