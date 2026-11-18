import { eq } from 'drizzle-orm';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Db } from '@mag/db';
import { waAccounts } from '@mag/db/schema';
import { JOB_RETENTION } from '@mag/shared';
import type { WaEngine } from '@mag/wa-engine';
import {
  chipAddress,
  matchPair,
  onIncoming,
  runJob,
  tick,
  util,
  warmupLlmFromEnv,
  type ChipState,
  type WarmupDeps,
  type WarmupJob,
} from '@mag/module-warmup';
import { isRoutable, policyWithDefaults, roleAllows, timelockUntil } from '../policies/anti-ban';
import type { WaEventHandler, WaEventHandlers } from './wa-events';

/** Maturador de chips: fila própria `warmup` (tick de 60 s + falas agendadas com delay). */
export const WARMUP_QUEUE = 'warmup';
export const WARMUP_TICK_JOB = 'warmup.tick';
export const WARMUP_JOB = 'warmup.job';
export const WARMUP_TICK_MS = 60_000;

/** 1 Queue por processo (lazy). */
let queue: Queue | null = null;

/** Fecha e esquece a Queue em cache (shutdown e testes). */
export async function closeWarmupQueue() {
  const q = queue;
  queue = null;
  await q?.close();
}

export type WarmupWiring = { db: Db; engine: WaEngine; connection: ConnectionOptions; prefix?: string };

export function warmupDeps(d: WarmupWiring): WarmupDeps {
  const q = () => (queue ??= new Queue(WARMUP_QUEUE, { connection: d.connection, prefix: d.prefix, defaultJobOptions: JOB_RETENTION }));
  return {
    db: d.db,
    llm: (model) => warmupLlmFromEnv(model),
    send: async ({ from, to, text }) => {
      const [f, t] = await Promise.all([chipAddress(d.db, from), chipAddress(d.db, to)]);
      if (!f || !t) throw new Error('Chip sem número conectado: não dá para enviar a fala.');
      await d.engine.send(f.session, t.chatId, { type: 'text', text });
    },
    chipState: async (id): Promise<ChipState> => {
      const [a] = await d.db.select().from(waAccounts).where(eq(waAccounts.id, id));
      const now = new Date();
      if (!a) return 'desconectado';
      if (isRoutable(a, 'send', now)) return 'ok';
      if (timelockUntil(a, now)) return 'restrito';
      const online = a.status === 'connected' || a.status === 'active' || a.status === 'restricted';
      return online && !roleAllows(policyWithDefaults(a.rolePolicy), 'send') ? 'sem-permissao' : 'desconectado';
    },
    schedule: async (job, delaySec) => {
      const turn = job.kind === 'line' ? job.idx : job.turn;
      await q().add(WARMUP_JOB, job, {
        // fala adiada por queda: id novo a cada tentativa (o BullMQ ignora id repetido)
        jobId: `warmup.${job.conversationId}.${turn}.${job.kind}${job.downSince ? `.retry${Date.now()}` : ''}`,
        delay: Math.max(0, delaySec) * 1000,
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
    },
    log: (m, e) => console.warn(m, e instanceof Error ? e.message : (e ?? '')),
  };
}

/** Worker da fila `warmup` + tick repetível (jobId fixo). Sobe no main.ts. */
export async function startWarmupWorker(connection: ConnectionOptions, deps: WarmupDeps, opts: { prefix?: string } = {}) {
  const tickQueue = new Queue(WARMUP_QUEUE, { connection, prefix: opts.prefix, defaultJobOptions: JOB_RETENTION });
  await tickQueue.upsertJobScheduler(WARMUP_TICK_JOB, { every: WARMUP_TICK_MS }, { name: WARMUP_TICK_JOB });
  const worker = new Worker(
    WARMUP_QUEUE,
    async (job) => (job.name === WARMUP_TICK_JOB ? tick(deps) : runJob(deps, job.data as WarmupJob)),
    { connection, prefix: opts.prefix, concurrency: 4 },
  );
  return {
    worker,
    close: async () => {
      await worker.close();
      await tickQueue.close();
      await closeWarmupQueue();
    },
  };
}

/** O GOWS manda o privado só com LID; o número vem em `_data.Info.SenderAlt` (`RecipientAlt` na própria). */
function altOf(raw: unknown, fromMe: boolean): string | null {
  const info = (raw as { payload?: { _data?: { Info?: Record<string, unknown> } } } | null | undefined)?.payload?._data?.Info;
  const alt = info?.[fromMe ? 'RecipientAlt' : 'SenderAlt'];
  return typeof alt === 'string' && alt ? alt.split('@')[0]!.split(':')[0]! : null;
}

type AnyHandler = WaEventHandler<never>;

/**
 * Camada mais externa do `message.in`: fala entre os dois chips de um par ativo é consumida aqui (vira só `onIncoming`)
 * e nunca chega aos demais handlers (anti-golpista inclusive). `match`/`incoming` são injetáveis só para teste.
 */
export function withWarmupHandlers(
  base: WaEventHandlers,
  d: { db: Db; deps: WarmupDeps; match?: typeof matchPair; incoming?: typeof onIncoming },
): WaEventHandlers {
  const match = d.match ?? matchPair;
  const incoming = d.incoming ?? onIncoming;
  const out = { ...base } as Record<string, AnyHandler>;
  /** Envolve um handler: privado entre os dois chips de um par ativo é consumido (`onPair` decide o efeito colateral). */
  const wrap = (kind: 'message.in' | 'message.ack', onPair: (e: never, ctx: never, pair: NonNullable<Awaited<ReturnType<typeof matchPair>>>) => Promise<void>) => {
    const theirs = out[kind];
    out[kind] = (async (e: never, ctx: never) => {
      const m = e as { session: string; chatId: string; fromMe?: boolean };
      const raw = (ctx as { raw?: unknown } | undefined)?.raw;
      const fromMe = Boolean(m.fromMe);
      // própria: o chat é o destinatário (`payload.to`)
      const to = (raw as { payload?: { to?: unknown } } | null | undefined)?.payload?.to;
      const chatId = fromMe && typeof to === 'string' && to ? to : m.chatId;
      if (util.isPrivateChat(chatId)) {
        const pair = await match(d.db, { session: m.session, chatId, altPhone: altOf(raw, fromMe) });
        if (pair) {
          await onPair(e, ctx, pair);
          return { handled: true };
        }
      }
      return theirs ? theirs(e, ctx) : undefined;
    }) as AnyHandler;
  };
  wrap('message.in', async (e, ctx, pair) => {
    const m = e as { fromMe: boolean; body?: string };
    // fala velha (backlog) não dispara resposta; erro da IA/fila só loga
    if (!(ctx as { stale?: boolean } | undefined)?.stale)
      try {
        await incoming(d.deps, { ...pair, fromMe: m.fromMe, text: m.body ?? '' });
      } catch (err) {
        console.error('[warmup] message.in', err);
      }
  });
  // o ack de mensagem entre os dois chips do par também é consumido aqui
  wrap('message.ack', async () => {});
  return out as WaEventHandlers;
}
