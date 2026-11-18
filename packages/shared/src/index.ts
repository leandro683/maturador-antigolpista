export * from './rng';
export * from './hmac';
export * from './phone';
export * from './module-manifest';

/** Retenção padrão no Redis: sem isso jobs concluídos/falhos se acumulam para sempre (Queue.defaultJobOptions). */
export const JOB_RETENTION = { removeOnComplete: 100, removeOnFail: 500 } as const;
