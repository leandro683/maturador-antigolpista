import type { Db } from '@mag/db';
import { buildHistoryRow, type HistoryInput } from '@mag/db';
import { history } from '@mag/db/schema';

/**
 * Grava 1 linha de histórico (best-effort — falha de audit não derruba a mutação; loga e segue).
 */
export async function recordHistory(db: Db, input: HistoryInput): Promise<boolean> {
  try {
    await db.insert(history).values(buildHistoryRow(input));
    return true;
  } catch (e) {
    console.warn(`[history] ${input.type} não gravado: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}
