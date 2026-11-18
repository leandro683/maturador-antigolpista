import { createSecHandlers, cachedSettings, type SecDeps } from '@mag/module-security';
import type { WaEventCtx, WaEventHandler, WaEventHandlers } from './wa-events';

/**
 * Anti-golpista no roteador `wa-events`: `message.in`, `message.reaction`, `group.participants` e `group.update`.
 * Esses kinds já têm dono (maturador, participantes, grupo) e o roteador guarda 1 handler por kind → o anti-golpista
 * entra por composição: `chainSecHandlers(base, sec)` roda o anti-golpista ANTES (lê nome/descrição esperados antes
 * de o dono gravar o valor do WhatsApp) e depois o dono; erro do anti-golpista é logado e nunca derruba o dono
 * (só não dá aval para o dono gravar nome/descrição de grupo).
 */

/** Handlers do anti-golpista. Interruptores globais com cache de 60 s (`settings` pode ser compartilhado com a varredura). */
export function secHandlers(deps: SecDeps): WaEventHandlers {
  const settings = deps.settings ?? cachedSettings(() => deps.repo.globalSettings());
  return createSecHandlers({ ...deps, settings }) as unknown as WaEventHandlers;
}

export function chainSecHandlers(
  base: WaEventHandlers,
  sec: WaEventHandlers,
  log: (m: string) => void = console.warn,
): WaEventHandlers {
  const out: Record<string, WaEventHandler> = { ...(base as Record<string, WaEventHandler>) };
  for (const [kind, h] of Object.entries(sec as Record<string, WaEventHandler>)) {
    const next = out[kind];
    out[kind] = async (e, ctx: WaEventCtx) => {
      let secNote: string | undefined;
      // sem aval do anti-golpista (atrasado, erro ou mudança não autorizada) o dono não grava nome/descrição
      let accepted = false;
      // evento atrasado: o anti-golpista não age sobre mensagem/entrada velha
      if (!ctx.stale)
        try {
          const r = (await h(e as never, ctx)) as { note?: string; incidents?: string[]; accepted?: boolean } | void;
          secNote = r?.incidents?.length ? `sec: ${r.note ?? 'incidente'}` : undefined;
          accepted = r?.accepted === true;
        } catch (err) {
          log(`[sec] ${kind} falhou: ${(err as Error).message}`);
        }
      const r = next ? await next(e as never, { ...ctx, secAccepted: accepted }) : undefined;
      return { ...(r ?? {}), ...(secNote ? { sec: secNote } : {}) };
    };
  }
  return out as WaEventHandlers;
}
