import { Redis } from 'ioredis';
import { Worker } from 'bullmq';
import { createAccountsService } from '@mag/accounts';
import { createDb } from '@mag/db';
import { cachedSettings, DrizzleSecRepo, phoneResolvingEngine } from '@mag/module-security';
import { WahaClient, wahaConfigFromEnv, type WaEngine } from '@mag/wa-engine';
import { FakeEngine } from '@mag/wa-engine/fake';
import { buildHandlers } from './handlers';
import { startSchedulerWorker } from './processors/scheduler';
import { resumeStaleScans, startSecScanWorker } from './processors/sec-scan';
import { createWaEventsProcessor, type WaEventsJob } from './processors/wa-events';
import { startWarmupWorker, warmupDeps } from './processors/warmup';

/**
 * Bootstrap do worker BullMQ. Env: REDIS_URL, DATABASE_URL, WAHA_URL/WAHA_API_KEY, APP_TZ.
 * Sem WAHA_URL só sobe com WA_FAKE_ENGINE=1 (dev; nada sai para o WhatsApp). Mesma ordem do painel:
 * WA_FAKE_ENGINE=1 vale mesmo com WAHA_URL.
 */
const SHUTDOWN_GRACE_MS = 25_000;

function engineFromEnv(env = process.env): WaEngine {
  if (env.WA_FAKE_ENGINE === '1') {
    console.warn('WA_FAKE_ENGINE=1: envios vão para o FakeEngine (nada sai para o WhatsApp)');
    return new FakeEngine();
  }
  if (env.WAHA_URL) return new WahaClient(wahaConfigFromEnv(env));
  throw new Error('WAHA_URL ausente (ou WA_FAKE_ENGINE=1 em dev)');
}

async function main() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL ausente');
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  // vigia: consulta pendurada no pooler prendia a vaga e o BullMQ renovava o lock para sempre (fila congelada)
  const { db, sql } = createDb(undefined, { socketTimeoutSec: 120 });

  // envio/participante por telefone resolve a variante real (com ou sem 9º dígito) e o LID conhecido
  const engine = phoneResolvingEngine(engineFromEnv(), db);
  const accounts = createAccountsService(db, engine);
  // interruptores globais do anti-golpista: 1 cache (60 s) para os handlers e para a varredura
  const secRepo = new DrizzleSecRepo(db);
  const settings = cachedSettings(() => secRepo.globalSettings());

  const warmupWiring = warmupDeps({ db, engine, connection });
  const warmup = await startWarmupWorker(connection, warmupWiring);
  const secScan = startSecScanWorker(connection, { db, engine, scan: { repo: secRepo, settings, db } });
  // análise que ficou parada por queda do worker volta para a fila
  await resumeStaleScans({ db, enqueue: secScan.enqueue, isQueued: secScan.isQueued });
  const scheduler = await startSchedulerWorker(connection, {
    db,
    enqueue: secScan.enqueue,
    isQueued: secScan.isQueued,
    tz: process.env.APP_TZ || 'America/Sao_Paulo',
  });
  const waEvents = new Worker<WaEventsJob>(
    'wa-events',
    createWaEventsProcessor({
      accountStatus: (e) => accounts.onSessionStatus(e),
      handlers: buildHandlers({ db, engine, warmup: warmupWiring, settings }),
    }),
    { connection, concurrency: 8 },
  );

  const workers = [waEvents, warmup.worker, secScan.worker, scheduler.worker];
  for (const w of workers) {
    w.on('failed', (job, err) => console.error(`[${w.name}] job ${job?.id} falhou:`, err.message));
  }
  console.log(`worker no ar: ${workers.map((w) => w.name).join(', ')}`);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig}: encerrando…`);
    // o docker mata em 30 s: espera os jobs ativos no máx. 25 s e sai
    const force = setTimeout(() => {
      console.warn(`encerramento passou de ${SHUTDOWN_GRACE_MS / 1000}s: saindo com job ativo`);
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    await Promise.allSettled([waEvents.close(), warmup.close(), secScan.close(), scheduler.close()]);
    await connection.quit();
    await sql.end({ timeout: 2 });
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
