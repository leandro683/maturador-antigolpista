import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Db } from '@mag/db';
import { runAutoScan, scanCreator, SEC_AUTO_SCAN_TASK } from '@mag/module-security';
import { JOB_RETENTION } from '@mag/shared';
import { resumeStaleScans } from './sec-scan';

/** Fila `scheduler`: análise automática diária (03h07, fuso `APP_TZ`) e retomada das análises paradas (a cada 3 min). */
export const SCHEDULER_QUEUE = 'scheduler';
export const SEC_AUTO_SCAN_CRON = '7 3 * * *';
export const SEC_RESUME_TASK = 'sec.resume-scans';
export const SEC_RESUME_EVERY_MS = 3 * 60_000;

export type SchedulerJob = { task: string };

/** Registra (idempotente) as tarefas repetíveis. */
export async function registerSchedules(queue: Pick<Queue, 'upsertJobScheduler'>, tz: string) {
  await queue.upsertJobScheduler(
    SEC_AUTO_SCAN_TASK,
    { pattern: SEC_AUTO_SCAN_CRON, tz },
    { name: SEC_AUTO_SCAN_TASK, data: { task: SEC_AUTO_SCAN_TASK } },
  );
  await queue.upsertJobScheduler(SEC_RESUME_TASK, { every: SEC_RESUME_EVERY_MS }, { name: SEC_RESUME_TASK, data: { task: SEC_RESUME_TASK } });
}

export function createSchedulerProcessor(d: {
  db: Db;
  enqueue: (childId: string) => Promise<void>;
  isQueued?: (childId: string) => Promise<boolean>;
  log?: (m: string) => void;
}) {
  return async (job: Job<SchedulerJob>) => {
    const log = d.log ?? console.log;
    const resume = () => resumeStaleScans({ db: d.db, enqueue: d.enqueue, ...(d.isQueued ? { isQueued: d.isQueued } : {}), log });
    if (job.data.task === SEC_RESUME_TASK) return { resumed: await resume() };
    if (job.data.task === SEC_AUTO_SCAN_TASK) {
      // antes de abrir análises novas, devolve à fila as que ficaram paradas (senão a campanha seria pulada)
      const resumed = await resume();
      return { ...(await runAutoScan({ db: d.db, create: scanCreator(d.db, d.enqueue), log })), resumed };
    }
    return { skipped: true, task: job.data.task };
  };
}

export async function startSchedulerWorker(
  connection: ConnectionOptions,
  d: { db: Db; enqueue: (childId: string) => Promise<void>; isQueued?: (childId: string) => Promise<boolean>; tz?: string },
) {
  // uma falha passageira não pode pular a noite inteira da análise automática
  const queue = new Queue(SCHEDULER_QUEUE, { connection, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, ...JOB_RETENTION } });
  await registerSchedules(queue, d.tz ?? 'America/Sao_Paulo');
  const worker = new Worker<SchedulerJob>(SCHEDULER_QUEUE, createSchedulerProcessor(d), { connection, concurrency: 1 });
  return {
    worker,
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
