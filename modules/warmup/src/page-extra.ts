import { sql } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { exec } from './util';

/** Modelo da conversa mais recente iniciada no dia de Brasília `day` (YYYY-MM-DD) e se ela foi paga; null se não houve conversa. */
export async function lastConversationToday(db: Db, day: string): Promise<{ paid: boolean; model: string | null } | null> {
  const [r] = await exec(
    db,
    sql`SELECT paid, model FROM mag.warmup_conversations
      WHERE started_at >= (${day}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
        AND started_at < ((${day}::date + 1))::timestamp AT TIME ZONE 'America/Sao_Paulo'
      ORDER BY started_at DESC LIMIT 1`,
  );
  return r ? { paid: Boolean(r.paid), model: (r.model as string | null) ?? null } : null;
}
