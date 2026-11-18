import 'server-only';
import { JOB_RETENTION } from '@mag/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

let conn: Redis | null = null;
const queues = new Map<string, Queue>();

/**
 * Conexão única dos PRODUTORES (só `Queue.add`, nunca Worker): com Redis fora o comando falha rápido
 * (2 tentativas, sem fila offline) e o erro sobe p/ quem chamou, em vez de pendurar a requisição.
 */
function producerRedis(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL ausente');
  conn ??= new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false, connectTimeout: 2000 });
  return conn;
}

/** Fila BullMQ (prefixo padrão) para enfileirar jobs; uma instância por nome. */
export function serverQueue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: producerRedis(),
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 2000 }, ...JOB_RETENTION },
    });
    queues.set(name, q);
  }
  return q;
}
