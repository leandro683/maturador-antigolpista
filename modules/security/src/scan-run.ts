import { and, asc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '@mag/db';
import { actions, actionSteps, campaigns, groups, waAccounts } from '@mag/db/schema';
import type { WaEngine } from '@mag/wa-engine';
import { scanStep, SECURITY_SCAN_TYPE, type ScanDeps, type ScanPayloadInput, type startScan } from './scan';

/**
 * Runner da varredura (`security-scan`): a ação pai guarda a campanha, 1 filho por conta e 1 passo por grupo.
 * `scanCreator` cria tudo e enfileira os filhos; `runScanChild` roda 1 passo (1 grupo) por chamada e diz se ainda
 * há mais — quem chama (worker) espera a pausa anti-ban entre grupos e reenfileira; `cancelScan` encerra.
 * Os valores de status e os contadores seguem o que `activeScan`/`listScans` leem.
 */

export const SEC_SCAN_QUEUE = 'sec-scan';

const WORKING = ['active', 'connected'];
const OPEN = ['queued', 'scheduled', 'processing', 'paused'] as const;
const RUNNABLE = ['queued', 'scheduled', 'processing'] as const;
const TERMINAL = ['success', 'failed', 'canceled'];

/**
 * Sem atividade por mais que isto = trabalhador morto: o passo `processing` volta a `pending` e o filho é devolvido por
 * `sweepStaleScans`. Passo vivo não envelhece: `runScanChild` bate o coração a cada `HEARTBEAT_MS`, então um grupo
 * grande e lento nunca passa deste prazo.
 */
export const STALE_MS = 5 * 60_000;
export const HEARTBEAT_MS = 60_000;
const ENQUEUE_FAILED = 'não foi possível enfileirar a análise (fila indisponível)';

type Status = (typeof actions.$inferSelect)['status'];

/** Devolve a função `create` que `startScan` espera: grava pai + filhos + passos e enfileira cada filho. */
export function scanCreator(
  db: Db,
  enqueue: (childId: string) => Promise<void>,
): Parameters<typeof startScan>[1] {
  return async (input) => {
    const [camp] = await db.select({ accountIds: campaigns.accountIds }).from(campaigns).where(eq(campaigns.id, input.campaignId));
    if (!camp) throw new Error('campanha não encontrada');
    const gs = await db
      .select({ id: groups.id, gid: groups.gid, waAccountId: groups.waAccountId })
      .from(groups)
      .where(and(eq(groups.campaignId, input.campaignId), eq(groups.suspended, false)))
      .orderBy(asc(groups.createdAt), asc(groups.id));
    if (!gs.length) throw new Error('a campanha não tem grupos para analisar');

    const ids = [...new Set([...gs.map((g) => g.waAccountId), ...camp.accountIds].filter((i): i is string => !!i))];
    const accs = await db
      .select({ id: waAccounts.id, status: waAccounts.status, rolePolicy: waAccounts.rolePolicy })
      .from(waAccounts)
      .where(inArray(waAccounts.id, ids));
    // conectada e que não é espiã (a espiã fica de fora para não chamar atenção)
    const apt = new Set(accs.filter((a) => WORKING.includes(a.status) && a.rolePolicy?.role !== 'spy').map((a) => a.id));
    const fallback = camp.accountIds.find((i) => apt.has(i));
    const byAccount = new Map<string, typeof gs>();
    for (const g of gs) {
      const acc = g.waAccountId && apt.has(g.waAccountId) ? g.waAccountId : fallback;
      if (!acc) throw new Error('nenhuma conta conectada (fora a espiã) para analisar os grupos desta campanha');
      byAccount.set(acc, [...(byAccount.get(acc) ?? []), g]);
    }

    const base = { type: input.type, campaignId: input.campaignId, payload: input.payload, options: input.options };
    const childIds = await db.transaction(async (tx) => {
      const [parent] = await tx.insert(actions).values({ ...base, status: 'queued', total: gs.length }).returning({ id: actions.id });
      const kids: string[] = [];
      for (const [accountId, list] of byAccount) {
        const [child] = await tx
          .insert(actions)
          .values({ ...base, parentId: parent!.id, waAccountId: accountId, status: 'queued', total: list.length })
          .returning({ id: actions.id });
        await tx.insert(actionSteps).values(list.map((g) => ({ actionId: child!.id, groupId: g.id, target: g.gid })));
        kids.push(child!.id);
      }
      return { parent: parent!.id, kids };
    });
    try {
      for (const id of childIds.kids) await enqueue(id);
    } catch (e) {
      // sem fila não há análise: cancela para não sobrar uma "em andamento" que trava a campanha
      // shortcut: se nem o cancelamento gravar, `sweepStaleScans` reenfileira os filhos depois
      await cancelScan(db, childIds.parent, ENQUEUE_FAILED).catch(() => {});
      throw new Error(`${ENQUEUE_FAILED}; a análise foi cancelada, tente de novo em instantes`, { cause: e });
    }
    return { id: childIds.parent };
  };
}

/** Contadores do filho recalculados dos passos (fonte da verdade). */
async function reconcileChild(db: Db, childId: string) {
  const rows = await db
    .select({ status: actionSteps.status, n: sql<number>`count(*)::int` })
    .from(actionSteps)
    .where(eq(actionSteps.actionId, childId))
    .groupBy(actionSteps.status);
  const c = { pending: 0, processing: 0, success: 0, failed: 0, skipped: 0 };
  for (const r of rows) c[r.status] = r.n;
  await db
    .update(actions)
    .set({
      total: c.pending + c.processing + c.success + c.failed + c.skipped,
      processed: c.success + c.failed + c.skipped,
      success: c.success,
      failed: c.failed,
      skipped: c.skipped,
      updatedAt: new Date(),
    })
    .where(eq(actions.id, childId));
  return c;
}

/** Pai = soma dos filhos + status derivado. Pai cancelado continua cancelado. */
async function reconcileParent(db: Db, parentId: string) {
  const [parent] = await db.select().from(actions).where(eq(actions.id, parentId));
  const kids = await db.select().from(actions).where(eq(actions.parentId, parentId));
  if (!parent || !kids.length) return;
  const st = kids.map((k) => k.status as string);
  const status: Status =
    parent.status === 'canceled'
      ? 'canceled'
      : st.includes('processing')
        ? 'processing'
        : st.every((s) => TERMINAL.includes(s))
          ? st.every((s) => s === 'canceled')
            ? 'canceled'
            : st.includes('failed')
              ? 'failed'
              : 'success'
          : 'queued';
  const sum = (k: 'total' | 'processed' | 'success' | 'failed' | 'skipped') => kids.reduce((a, c) => a + c[k], 0);
  const started = kids.map((k) => k.startedAt).filter((d): d is Date => !!d);
  await db
    .update(actions)
    .set({
      status,
      total: sum('total'),
      processed: sum('processed'),
      success: sum('success'),
      failed: sum('failed'),
      skipped: sum('skipped'),
      startedAt: parent.startedAt ?? (started.length ? new Date(Math.min(...started.map((d) => d.getTime()))) : null),
      finishedAt: TERMINAL.includes(status) ? (parent.finishedAt ?? new Date()) : null,
      updatedAt: new Date(),
    })
    // um cancelamento que chegou depois da leitura acima não pode ser desfeito
    .where(and(eq(actions.id, parentId), status === 'canceled' ? undefined : ne(actions.status, 'canceled')));
}

/**
 * Pega o próximo passo do filho de forma atômica. A linha do filho fica travada durante a pegada, então chamadas
 * concorrentes ao mesmo filho se enfileiram aqui: quem chega depois vê o passo `processing` recente e desiste (`busy`).
 * `processing` só volta a `pending` quando está velho (trabalhador morto); o passo é pego por UM update com condição
 * de status e `returning`.
 */
async function claimStep(db: Db, childId: string) {
  return db.transaction(async (tx) => {
    const [child] = await tx
      .select()
      .from(actions)
      .where(and(eq(actions.id, childId), inArray(actions.status, [...RUNNABLE])))
      .for('update');
    if (!child?.parentId) return { kind: 'gone' as const };
    const [parent] = await tx.select({ status: actions.status }).from(actions).where(eq(actions.id, child.parentId));
    if (!parent || parent.status === 'canceled') return { kind: 'gone' as const };

    const now = new Date();
    // shortcut: retomada simples, a varredura deduplica por dedupKey
    await tx
      .update(actionSteps)
      .set({ status: 'pending', updatedAt: now })
      .where(
        and(
          eq(actionSteps.actionId, childId),
          eq(actionSteps.status, 'processing'),
          lt(actionSteps.updatedAt, new Date(now.getTime() - STALE_MS)),
        ),
      );
    const [busy] = await tx
      .select({ id: actionSteps.id })
      .from(actionSteps)
      .where(and(eq(actionSteps.actionId, childId), eq(actionSteps.status, 'processing')))
      .limit(1);
    if (busy) return { kind: 'busy' as const };

    await tx
      .update(actions)
      .set({ status: 'processing', startedAt: child.startedAt ?? now, updatedAt: now })
      .where(eq(actions.id, childId));
    const next = tx
      .select({ id: actionSteps.id })
      .from(actionSteps)
      .where(and(eq(actionSteps.actionId, childId), eq(actionSteps.status, 'pending')))
      .orderBy(asc(actionSteps.createdAt), asc(actionSteps.id))
      .limit(1)
      .for('update', { skipLocked: true });
    const [step] = await tx
      .update(actionSteps)
      .set({ status: 'processing', attempts: sql`${actionSteps.attempts} + 1`, updatedAt: now })
      .where(and(eq(actionSteps.status, 'pending'), inArray(actionSteps.id, next)))
      .returning();
    return { kind: 'ok' as const, child, step };
  });
}

/**
 * Roda o próximo passo pendente do filho (1 grupo) com a sessão da conta dele e grava resultado/erro.
 * Devolve `more: true` enquanto houver passo pendente (o worker reenfileira depois da pausa entre grupos).
 * Pai cancelado (ou filho que não está mais em andamento): não processa nada.
 */
export async function runScanChild(
  deps: { db: Db; engine: WaEngine; scan: ScanDeps; heartbeatMs?: number },
  childId: string,
): Promise<{ more: boolean }> {
  const { db } = deps;
  const claim = await claimStep(db, childId);
  // `busy`: outro trabalhador está num passo vivo deste filho e este job sai sem fazer nada (a corrente dele continua);
  // se aquele trabalhador morreu, o passo envelhece e a tarefa repetida do worker devolve o filho à fila
  if (claim.kind !== 'ok') return { more: false };
  const { child, step } = claim;

  if (step) {
    // só grava se o passo ainda é desta pegada (outra chamada pode ter retomado um passo velho)
    const mine = and(eq(actionSteps.id, step.id), eq(actionSteps.status, 'processing'), eq(actionSteps.attempts, step.attempts));
    // batimento: enquanto o passo roda, passo e filho mostram atividade recente (erro de banco aqui não derruba o passo)
    const beat = setInterval(() => {
      const now = new Date();
      void Promise.all([
        db.update(actionSteps).set({ updatedAt: now }).where(mine),
        db.update(actions).set({ updatedAt: now }).where(eq(actions.id, childId)),
      ]).catch(() => {});
    }, deps.heartbeatMs ?? HEARTBEAT_MS);
    try {
      const patch = await runStep(deps, child, child.parentId!, step);
      await db.update(actionSteps).set({ ...patch, updatedAt: new Date() }).where(mine);
    } catch (e) {
      // queda do banco/fila fora do try do passo: devolve o passo à fila; se nem isso gravar, ele fica velho e é retomado
      try {
        await db.update(actionSteps).set({ status: 'pending', updatedAt: new Date() }).where(mine);
      } catch {
        /* o erro original abaixo é o que importa */
      }
      throw e;
    } finally {
      clearInterval(beat);
    }
  }

  const c = await reconcileChild(db, childId);
  const more = c.pending + c.processing > 0;
  if (!more)
    await db
      .update(actions)
      .set({ status: c.failed > 0 ? 'failed' : 'success', finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(actions.id, childId), inArray(actions.status, [...RUNNABLE])));
  await reconcileParent(db, child.parentId!);
  return { more };
}

/**
 * Filhos de análise em andamento (`queued`/`processing`) sem atividade há mais que `olderThanMs` (padrão `STALE_MS`):
 * o worker reenfileira cada um (na partida, a cada poucos minutos e antes da análise diária). Filho de análise cancelada ou concluída nunca volta.
 */
export async function sweepStaleScans(db: Db, opts: { olderThanMs?: number } = {}): Promise<string[]> {
  const cutoff = new Date(Date.now() - (opts.olderThanMs ?? STALE_MS));
  const parent = alias(actions, 'scan_parent');
  const rows = await db
    .select({ id: actions.id })
    .from(actions)
    .innerJoin(parent, eq(parent.id, actions.parentId))
    .where(
      and(
        eq(actions.type, SECURITY_SCAN_TYPE),
        inArray(actions.status, ['queued', 'processing']),
        lt(actions.updatedAt, cutoff),
        inArray(parent.status, [...OPEN]),
      ),
    );
  return rows.map((r) => r.id);
}

async function runStep(
  deps: { db: Db; engine: WaEngine; scan: ScanDeps },
  child: typeof actions.$inferSelect,
  parentId: string,
  step: typeof actionSteps.$inferSelect,
): Promise<{ status: 'success' | 'failed'; error: string | null; result: Record<string, unknown> | null }> {
  const { db } = deps;
  try {
    const [acc] = child.waAccountId ? await db.select().from(waAccounts).where(eq(waAccounts.id, child.waAccountId)) : [];
    if (!acc) throw new Error('conta da análise não encontrada');
    const { result } = await scanStep({ ...deps.scan, db: deps.scan.db ?? db }, deps.engine, {
      session: acc.sessionName,
      gid: step.target ?? '',
      groupId: step.groupId,
      payload: child.payload as ScanPayloadInput,
      index: child.processed,
      actionId: parentId,
      accountId: acc.id,
      campaignId: child.campaignId,
    });
    return { status: 'success', error: null, result: result as unknown as Record<string, unknown> };
  } catch (e) {
    return { status: 'failed', error: (e instanceof Error ? e.message : String(e)).slice(0, 500), result: null };
  }
}

/** Cancela a análise: o pai primeiro (os runners param), depois filhos em aberto e passos pendentes. Idempotente. */
export async function cancelScan(db: Db, scanId: string, reason = 'canceled'): Promise<void> {
  const [parent] = await db.select().from(actions).where(and(eq(actions.id, scanId), isNull(actions.parentId)));
  if (!parent || TERMINAL.includes(parent.status)) return;
  const now = new Date();
  await db.update(actions).set({ status: 'canceled', finishedAt: now, updatedAt: now }).where(eq(actions.id, scanId));
  const open = await db
    .select({ id: actions.id })
    .from(actions)
    .where(and(eq(actions.parentId, scanId), inArray(actions.status, [...OPEN])));
  for (const { id } of open) {
    await db
      .update(actionSteps)
      .set({ status: 'skipped', error: reason, updatedAt: now })
      .where(and(eq(actionSteps.actionId, id), eq(actionSteps.status, 'pending')));
    await db.update(actions).set({ status: 'canceled', finishedAt: now, updatedAt: now }).where(eq(actions.id, id));
    await reconcileChild(db, id);
  }
  await reconcileParent(db, scanId);
}
