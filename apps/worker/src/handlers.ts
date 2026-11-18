import { eq, sql } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { groups } from '@mag/db/schema';
import { DrizzleSecRepo, inviteCodeOf, topicOf, type SecDeps } from '@mag/module-security';
import type { WarmupDeps } from '@mag/module-warmup';
import type { WaEngine } from '@mag/wa-engine';
import { DrizzleParticipantsRepo } from './repos/drizzle';
import { legacyParticipants, type WaEventHandler, type WaEventHandlers } from './processors/wa-events';
import { chainSecHandlers, secHandlers } from './processors/sec-events';
import { withWarmupHandlers } from './processors/warmup';

/** Tudo o que os handlers do `wa-events` precisam. */
export type WorkerDeps = {
  db: Db;
  engine: WaEngine;
  warmup: WarmupDeps;
  /** interruptores globais do anti-golpista (cache de 60 s); passe o mesmo da varredura para compartilhar o cache */
  settings?: SecDeps['settings'];
  log?: (m: string) => void;
};

/**
 * `group.update`: nome, descrição, convite e "só admins falam" mudaram fora do painel → grava no grupo.
 * Nome e descrição só entram com o aval do anti-golpista (`ctx.secAccepted`): o valor gravado é o que ele usa como
 * "esperado"; se uma mudança não autorizada o substituísse, o golpista viraria o nome oficial.
 */
function donoDoGrupo(db: Db): WaEventHandler<'group.update'> {
  return async (e, ctx) => {
    // atrasado: o convite velho pode já ter sido revogado, então não sobrescreve nada
    if (ctx.stale) return { note: 'atrasado: ignorado' };
    const code = inviteCodeOf(e.inviteCode);
    const description = e.description ?? topicOf(ctx.raw); // a mesma fonte que o anti-golpista usou para julgar
    const set = {
      ...(ctx.secAccepted && e.subject ? { name: e.subject } : {}),
      ...(ctx.secAccepted && description !== undefined ? { description: description || null } : {}),
      ...(code ? { inviteCode: code } : {}),
      ...(e.announce !== undefined
        ? { settings: sql`${groups.settings} || ${JSON.stringify({ announce: e.announce })}::jsonb` }
        : {}),
    };
    if (!Object.keys(set).length) return { note: ctx.secAccepted ? 'sem campo conhecido' : 'sem aval do anti-golpista: nome/descrição não gravados' };
    const rows = await db.update(groups).set({ ...set, updatedAt: new Date() }).where(eq(groups.gid, e.gid)).returning({ id: groups.id });
    return rows.length ? undefined : { handled: false, note: 'grupo desconhecido' };
  };
}

/**
 * Ordem (de dentro para fora): dono do kind → anti-golpista antes do dono → maturador por fora.
 * Fala entre os dois chips de um par do maturador é consumida no maturador e nunca chega ao anti-golpista.
 */
export function buildHandlers(d: WorkerDeps): WaEventHandlers {
  const participants = new DrizzleParticipantsRepo(d.db);
  const sec = secHandlers({
    repo: new DrizzleSecRepo(d.db),
    engine: d.engine,
    log: d.log ?? console.warn,
    ...(d.settings ? { settings: d.settings } : {}),
  });
  return withWarmupHandlers(
    chainSecHandlers(
      { 'group.participants': (e) => legacyParticipants(e, participants), 'group.update': donoDoGrupo(d.db) },
      sec,
      d.log,
    ),
    { db: d.db, deps: d.warmup },
  );
}
