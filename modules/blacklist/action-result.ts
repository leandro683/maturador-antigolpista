/** Retorno padrão das server actions do módulo de bloqueados (UI mostra `error` em pt-BR). */
export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

export const ok = <T>(data: T): ActionResult<T> => ({ ok: true, data });

/**
 * Pergunta de confirmação. O painel injeta o diálogo do `@/components/ui/confirm` (`actions.ask`) — módulos não
 * importam de apps/web; sem injeção cai no `window.confirm`.
 */
export type Ask = (o: {
  title: string;
  message?: string;
  confirmLabel?: string;
  tone?: 'danger' | 'default';
}) => Promise<boolean>;
export const nativeAsk: Ask = async (o) => window.confirm(o.message ? `${o.title}\n\n${o.message}` : o.title);

/** Converte erro (zod, banco, regra) em mensagem curta p/ o usuário. */
export function fail(e: unknown): { ok: false; error: string } {
  const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] })?.issues;
  if (Array.isArray(issues) && issues.length)
    return {
      ok: false,
      error: issues
        .slice(0, 3)
        .map((i) => (i.path.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message))
        .join(' · '),
    };
  return { ok: false, error: e instanceof Error ? e.message : 'erro inesperado' };
}
