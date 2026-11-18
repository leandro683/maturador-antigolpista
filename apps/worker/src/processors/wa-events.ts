import type { Job } from 'bullmq';
import { mapWahaEvent, type EventParticipant, type WaEvent, type WahaWebhook } from '@mag/wa-engine';
import { phoneFromJid } from '@mag/shared';
import type { ParticipantsRepo } from '../repos/types';

/**
 * Roteador do processor `wa-events`: webhook cru do WAHA → `mapWahaEvent` → handler por `kind`.
 * `session.status` vai para o serviço de contas; os demais kinds vêm de `handlers` (montados em `../handlers.ts`).
 */

/** Job da fila `wa-events`: o webhook cru, como o painel o recebe do WAHA. */
export type WaEventsJob = { webhook: WahaWebhook };

export type HandleResult = {
  handled: boolean;
  kind: WaEvent['kind'] | null;
  note?: string;
  [k: string]: unknown;
};

/**
 * Evento com mais de 10 min (pela hora do PRÓPRIO evento, `e.ts`) grava dados mas não age (sem anti-golpista,
 * sem maturador, sem status de sessão). Webhook sem timestamp: o mapper usa "agora"; por isso o processor usa
 * o mais antigo entre `e.ts` e a hora de entrada do job na fila.
 */
export const STALE_EVENT_MS = 600_000;
export function isStaleEvent(ts: number, now: number = Date.now()): boolean {
  return now - ts > STALE_EVENT_MS;
}

export type WaEventCtx = {
  raw: WahaWebhook | null;
  stale: boolean;
  /** só `group.update`, preenchido por `chainSecHandlers`: o anti-golpista aceitou a mudança de nome/descrição (ausente = não gravar) */
  secAccepted?: boolean;
};
export type WaEventHandler<K extends WaEvent['kind'] = WaEvent['kind']> = (
  e: Extract<WaEvent, { kind: K }>,
  ctx: WaEventCtx,
) => Promise<Partial<HandleResult> | void>;
export type WaEventHandlers = { [K in WaEvent['kind']]?: WaEventHandler<K> };

export type WaEventsDeps = {
  /** session.status → contas (`createAccountsService(db, engine).onSessionStatus`) */
  accountStatus?: (e: Extract<WaEvent, { kind: 'session.status' }>) => Promise<HandleResult>;
  handlers: WaEventHandlers;
};

/** E.164 se o JID tiver telefone; senão o JID cru (LID-only). */
function phoneKey(p: EventParticipant): string {
  return phoneFromJid(p.jid) ?? p.jid;
}

/** Participantes + contadores do grupo. */
export async function legacyParticipants(
  e: Extract<WaEvent, { kind: 'group.participants' }>,
  repo: ParticipantsRepo,
): Promise<HandleResult> {
  const g = await repo.findGroupByGid(e.gid);
  if (!g) return { handled: false, kind: e.kind, note: 'grupo desconhecido' };
  const phones = e.participants.map(phoneKey);
  const at = new Date(e.ts);
  if (e.action === 'add') {
    await repo.upsertParticipants(
      g.id,
      e.participants.map((p) => ({ phone: phoneKey(p), lid: p.lid ?? null, joinedAt: at })),
    );
  } else if (e.action === 'remove') {
    await repo.markLeft(g.id, phones, at);
  } else {
    await repo.setAdmin(g.id, phones, e.action === 'promote');
  }
  await repo.refreshCounters(g.id);
  return { handled: true, kind: e.kind };
}

export async function handleWaEvent(
  e: WaEvent,
  deps: WaEventsDeps,
  raw: WahaWebhook | null = null,
  /** hora em que o job entrou na fila (BullMQ `job.timestamp`): evento sem hora real (mapper usou "agora") ainda conta */
  enqueuedAt?: number,
): Promise<HandleResult> {
  const stale = isStaleEvent(enqueuedAt === undefined ? e.ts : Math.min(e.ts, enqueuedAt));
  if (e.kind === 'session.status') {
    // o status atual vem da própria sessão; um status velho só atrapalharia
    if (stale) return { handled: true, kind: e.kind, note: 'atrasado: ignorado' };
    return deps.accountStatus
      ? deps.accountStatus(e)
      : { handled: false, kind: e.kind, note: 'contas não configuradas' };
  }

  const h = deps.handlers[e.kind] as WaEventHandler | undefined;
  if (h) {
    const r = await h(e as never, { raw, stale });
    return { handled: true, ...(r ?? {}), kind: e.kind };
  }
  return { handled: false, kind: e.kind, note: 'sem handler' };
}

export function createWaEventsProcessor(deps: WaEventsDeps) {
  return async (job: Job<WaEventsJob>): Promise<HandleResult> => {
    const raw = job.data.webhook;
    const e = mapWahaEvent(raw);
    if (!e) return { handled: false, kind: null, note: `ignorado: ${raw.event}` };
    return handleWaEvent(e, deps, raw, job.timestamp);
  };
}
