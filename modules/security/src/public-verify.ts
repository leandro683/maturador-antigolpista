import { randomInt } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { campaigns, collaboratorPages } from '@mag/db/schema';
import { verifyNumber } from './collaborators';
import { ReactionLimiter } from './limiter';

/**
 * Página pública /verificar/<slug> (fora do painel). Qualquer pessoa digita um número e recebe SÓ
 * "é da equipe" / "não é da equipe" — nunca nomes, ids ou a lista. Cada consulta entra no histórico (canal `publico`).
 */

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const newSlug = () => Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

export type VerifyPageRow = typeof collaboratorPages.$inferSelect;

/** Cria (uma vez) a página da campanha com slug aleatório, DESLIGADA (o operador liga); chamadas seguintes devolvem a mesma. */
export async function ensureVerifyPage(db: Db, campaignId: string): Promise<VerifyPageRow> {
  for (let i = 0; i < 3; i++) {
    await db.insert(collaboratorPages).values({ campaignId, slug: newSlug(), enabled: false }).onConflictDoNothing();
    const [row] = await db
      .select()
      .from(collaboratorPages)
      .where(eq(collaboratorPages.campaignId, campaignId))
      .limit(1);
    if (row) return row;
  }
  throw new Error('não foi possível criar a página pública');
}

export async function setVerifyPage(
  db: Db,
  campaignId: string,
  input: { enabled: boolean; eventName?: string | null },
  by?: string | null,
): Promise<void> {
  await ensureVerifyPage(db, campaignId);
  await db
    .update(collaboratorPages)
    .set({
      enabled: input.enabled,
      eventName: input.eventName?.trim().slice(0, 120) || null,
      updatedBy: by ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(collaboratorPages.campaignId, campaignId));
}

async function pageBySlug(db: Db, slug: string) {
  if (!/^[a-z0-9]{6,32}$/.test(slug)) return null;
  const [r] = await db
    .select({
      slug: collaboratorPages.slug,
      campaignId: collaboratorPages.campaignId,
      eventName: collaboratorPages.eventName,
      name: campaigns.name,
    })
    .from(collaboratorPages)
    .innerJoin(campaigns, eq(campaigns.id, collaboratorPages.campaignId))
    .where(sql`${collaboratorPages.slug} = ${slug} AND ${collaboratorPages.enabled} AND NOT ${campaigns.archived}`)
    .limit(1);
  return r ?? null;
}

/** Título neutro até o operador dar um nome ao evento: o nome interno da operação não sai da casa. */
export const PUBLIC_VERIFY_TITLE = 'Verificação da equipe';

/** Dados que a página pública pode mostrar (título). Desligada/inexistente → null (404). */
export async function publicVerifyPage(db: Db, slug: string): Promise<{ slug: string; title: string } | null> {
  const p = await pageBySlug(db, slug);
  return p ? { slug: p.slug, title: p.eventName ?? PUBLIC_VERIFY_TITLE } : null;
}

export type PublicVerifyStatus = 'equipe' | 'nao-equipe' | 'invalido';

/** Consulta pública: só o veredito. Página desligada/inexistente → null. */
export async function publicVerify(
  db: Db,
  slug: string,
  query: string,
): Promise<{ status: PublicVerifyStatus } | null> {
  const p = await pageBySlug(db, slug);
  if (!p) return null;
  const r = await verifyNumber(db, p.campaignId, query, { channel: 'publico' });
  return { status: !r.valid ? 'invalido' : r.result ? 'equipe' : 'nao-equipe' };
}

/**
 * Limite da consulta pública: 10/min por IP e 120/min por página (enumeração por muitos IPs).
 * Sem IP confiável (`ip: null`, painel sem proxy que sobrescreva o cabeçalho) só vale o limite da página.
 * shortcut: em memória por processo (o painel roda em 1 processo); com várias réplicas, mover p/ Redis.
 */
export function createPublicLimiter(now: () => number = Date.now) {
  const perIp = new ReactionLimiter(10, 60_000, now);
  const perPage = new ReactionLimiter(120, 60_000, now);
  return (ip: string | null, slug: string) => (ip === null || perIp.take(`${slug}:${ip}`)) && perPage.take(slug);
}
