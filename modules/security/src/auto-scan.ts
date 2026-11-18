import { eq } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { campaigns } from '@mag/db/schema';
import { readAntiHacker } from './config';
import { activeScan, ScanAlreadyRunningError, startScan } from './scan';

/** Tarefa da fila `scheduler` (1 vez por dia, 03h07 de São Paulo). */
export const SEC_AUTO_SCAN_TASK = 'sec.auto-scan';
/** A rodada diária confere só quem entrou nesta janela (sem rodada completa: menos consultas = menos risco de ban). */
export const AUTO_SCAN_WINDOW_MS = 48 * 60 * 60_000;

/**
 * Vigia automática: para cada campanha ativa com a caixa ligada (modo `auto` + `impersonationAutoScan`) cria uma
 * análise `security-scan` que age sozinha (`autoAct`). Análise já em andamento = pula (nada duplicado). Uma campanha
 * com erro não impede as demais.
 */
export async function runAutoScan(deps: {
  db: Db;
  create: Parameters<typeof startScan>[1];
  now?: () => Date;
  log?: (m: string) => void;
}): Promise<{ started: string[]; skipped: string[]; failed: string[] }> {
  const { db, create } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - AUTO_SCAN_WINDOW_MS).toISOString();
  const rows = await db
    .select({ id: campaigns.id, antiHacker: campaigns.antiHacker })
    .from(campaigns)
    .where(eq(campaigns.archived, false));
  const out = { started: [] as string[], skipped: [] as string[], failed: [] as string[] };
  for (const r of rows) {
    const c = readAntiHacker(r.antiHacker);
    if (!c.enabled || c.impersonation !== 'auto' || !c.impersonationAutoScan || c.dryRun) continue;
    try {
      if (await activeScan(db, r.id)) {
        out.skipped.push(r.id);
        continue;
      }
      await startScan(db, create, r.id, { messageLimit: 0, checkProfiles: true, autoAct: true, since });
      out.started.push(r.id);
    } catch (e) {
      if (e instanceof ScanAlreadyRunningError) out.skipped.push(r.id);
      else {
        out.failed.push(r.id);
        log(`[sec] análise automática: ${r.id} falhou: ${(e as Error).message}`);
      }
    }
  }
  log(`[sec] análise automática: ${out.started.length} iniciada(s), ${out.skipped.length} pulada(s), ${out.failed.length} com erro`);
  return out;
}
