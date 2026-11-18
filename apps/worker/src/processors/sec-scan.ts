import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Db } from '@mag/db';
import { runScanChild, SEC_SCAN_QUEUE, sweepStaleScans, type ScanDeps } from '@mag/module-security';
import { JOB_RETENTION } from '@mag/shared';
import type { WaEngine } from '@mag/wa-engine';

/** Job da fila `sec-scan`: um filho da análise (as contas varrem os grupos dela, 1 grupo por vez). */
export type SecScanJob = { childId: string };

/** Pausa anti-ban entre um grupo e o próximo: 40–60 s. */
export const SCAN_GAP_MIN_MS = 40_000;
export const SCAN_GAP_MAX_MS = 60_000;

/** Cada job tenta de novo se o passo falhar (banco/Redis fora por um instante): o passo volta a `pending` e a nova tentativa continua. */
export const SCAN_JOB_OPTIONS = { attempts: 5, backoff: { type: 'exponential' as const, delay: 5000 } };

type ScanQueue = Pick<Queue<SecScanJob>, 'add'>;

/** Enfileira um filho da análise. Lança se a fila falhar: é isso que faz `scanCreator` cancelar a análise com mensagem. */
export function scanEnqueuer(queue: ScanQueue) {
  return async (childId: string): Promise<void> => {
    await queue.add('scan', { childId });
  };
}

/** Diz se a fila já tem um job (esperando, ativo ou adiado) para o filho: ele está na vez, não parado. */
export function scanQueued(queue: Pick<Queue<SecScanJob>, 'getJobs'>) {
  return async (childId: string): Promise<boolean> =>
    (await queue.getJobs(['waiting', 'active', 'delayed', 'prioritized'])).some((j) => j.data.childId === childId);
}

/**
 * Reenfileira os filhos de análise parados (worker morto no meio de um passo). Devolve quantos voltaram à fila.
 * `isQueued` evita duplicar o filho que só está esperando a vez numa fila cheia.
 */
export async function resumeStaleScans(d: {
  db: Db;
  enqueue: (childId: string) => Promise<void>;
  isQueued?: (childId: string) => Promise<boolean>;
  log?: (m: string) => void;
}): Promise<number> {
  const log = d.log ?? console.warn;
  let n = 0;
  for (const id of await sweepStaleScans(d.db)) {
    try {
      if (await d.isQueued?.(id)) continue;
      await d.enqueue(id);
      n++;
    } catch (e) {
      log(`[sec-scan] não foi possível retomar a análise ${id}: ${(e as Error).message}`);
    }
  }
  if (n) log(`[sec-scan] ${n} análise(s) parada(s) retomada(s)`);
  return n;
}

/**
 * Roda 1 grupo; se ainda sobra (`more`), reenfileira o mesmo filho com atraso aleatório. Erro de `runScanChild` sobe para
 * o BullMQ tentar de novo; `more: false` (acabou, cancelada ou outro trabalhador está no passo) encerra a corrente.
 */
export function createSecScanProcessor(d: {
  db: Db;
  engine: WaEngine;
  scan: ScanDeps;
  queue: ScanQueue;
  rnd?: () => number;
}) {
  const rnd = d.rnd ?? Math.random;
  return async (job: Job<SecScanJob>): Promise<{ more: boolean }> => {
    const { childId } = job.data;
    const r = await runScanChild({ db: d.db, engine: d.engine, scan: d.scan }, childId);
    if (r.more) {
      const delay = SCAN_GAP_MIN_MS + Math.floor(rnd() * (SCAN_GAP_MAX_MS - SCAN_GAP_MIN_MS));
      await d.queue.add('scan', { childId }, { delay });
    }
    return r;
  };
}

/** `prefix` só serve aos testes (fila própria no Redis compartilhado); em produção fica o padrão do BullMQ. */
export const createScanQueue = (connection: ConnectionOptions, prefix?: string) =>
  new Queue<SecScanJob>(SEC_SCAN_QUEUE, {
    connection,
    ...(prefix ? { prefix } : {}),
    defaultJobOptions: { ...SCAN_JOB_OPTIONS, ...JOB_RETENTION },
  });

/** Fila + worker (concorrência 2) de `sec-scan`. `enqueue` serve a quem cria a análise e `isQueued` a quem a retoma (scheduler). */
export function startSecScanWorker(connection: ConnectionOptions, d: { db: Db; engine: WaEngine; scan: ScanDeps }) {
  const queue = createScanQueue(connection);
  const worker = new Worker<SecScanJob>(SEC_SCAN_QUEUE, createSecScanProcessor({ ...d, queue }), {
    connection,
    concurrency: 2,
  });
  return {
    worker,
    enqueue: scanEnqueuer(queue),
    isQueued: scanQueued(queue),
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
