import { and, count, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { campaigns, groups } from '@mag/db/schema';
import { incidents, SCAN_KINDS, type IncidentKind, type IncidentRow } from './tables';

/** Consulta, resolução e export do log de incidentes. */

export const KIND_LABEL: Record<IncidentKind, string> = {
  message: 'Mensagem de não-admin',
  promote: 'Promoção não autorizada',
  admin_lost: 'Conta perdeu admin',
  group_update: 'Nome/descrição alterados',
  blocked_join: 'Bloqueado entrou',
  audit: 'Auditoria de admins',
  reaction: 'Mensagem revelada por reação',
  'scan.blacklisted': 'Análise: bloqueado no grupo',
  'scan.non-admin-message': 'Análise: mensagem de não-admin',
  'scan.unknown-admin': 'Análise: admin desconhecido',
  'scan.impersonator': 'Possível impostor',
};

export const STATUS_LABEL: Record<string, string> = {
  acted: 'Ação tomada',
  partial: 'Ação parcial',
  failed: 'Falhou',
  dry_run: 'Simulação',
  rate_limited: 'Limite de reações',
  ignored: 'Ignorado',
  reverted: 'Revertido',
  open: 'Aguardando decisão',
};

export type IncidentFilter = {
  campaignId?: string;
  kind?: IncidentKind;
  /** só os achados de uma análise (details.scanId) */
  scanId?: string;
  from?: Date;
  to?: Date;
  open?: boolean;
  page?: number;
  pageSize?: number;
};

export type IncidentListItem = IncidentRow & { campaignName: string | null; groupName: string | null };

function where(f: IncidentFilter): SQL | undefined {
  const w: SQL[] = [];
  if (f.campaignId) w.push(eq(incidents.campaignId, f.campaignId));
  if (f.kind) w.push(eq(incidents.kind, f.kind));
  if (f.scanId)
    w.push(inArray(incidents.kind, [...SCAN_KINDS]), sql`${incidents.details} ->> 'scanId' = ${f.scanId}`);
  if (f.from) w.push(gte(incidents.createdAt, f.from));
  if (f.to) w.push(lt(incidents.createdAt, f.to));
  if (f.open) w.push(sql`${incidents.resolvedAt} is null`);
  return w.length ? and(...w) : undefined;
}

export async function listIncidents(
  db: Db,
  f: IncidentFilter = {},
): Promise<{ rows: IncidentListItem[]; total: number }> {
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const cond = where(f);
  const rows = await db
    .select({ i: incidents, campaignName: campaigns.name, groupName: groups.name })
    .from(incidents)
    .leftJoin(campaigns, eq(campaigns.id, incidents.campaignId))
    .leftJoin(groups, eq(groups.id, incidents.groupId))
    .where(cond)
    .orderBy(desc(incidents.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [t] = await db.select({ n: count() }).from(incidents).where(cond);
  return {
    rows: rows.map((r) => ({ ...r.i, campaignName: r.campaignName, groupName: r.groupName })),
    total: Number(t?.n ?? 0),
  };
}

/** "Ignorar" (falso positivo) ou "revertido" (equipe desfez manualmente: desbloqueou/readicionou). */
export async function resolveIncidents(
  db: Db,
  ids: string[],
  status: 'ignored' | 'reverted',
  by?: string | null,
): Promise<void> {
  if (!ids.length) return;
  await db
    .update(incidents)
    .set({ status, resolvedAt: sql`now()`, resolvedBy: by ?? null })
    .where(inArray(incidents.id, ids));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
};

const fmt = (d: Date) => d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

/** CSV (`;`, pt-BR) — relatório de incidentes/banimentos por número. */
export function incidentsCsv(rows: IncidentListItem[]): string {
  const head = ['Data', 'Tipo', 'Status', 'Número', 'LID', 'Autor', 'Campanha', 'Grupo', 'Ações'];
  const lines = rows.map((r) =>
    [
      fmt(r.createdAt),
      KIND_LABEL[r.kind] ?? r.kind,
      STATUS_LABEL[r.status] ?? r.status,
      r.phone,
      r.lid,
      r.actor,
      r.campaignName,
      r.groupName ?? r.gid,
      r.actions.map((a) => `${a.type}:${a.ok ? 'ok' : 'erro'}`).join(' '),
    ]
      .map(csvCell)
      .join(';'),
  );
  return '﻿' + [head.join(';'), ...lines].join('\r\n') + '\r\n';
}

/** Relatório por número: quantos incidentes cada telefone/LID teve. */
export async function incidentsByNumber(db: Db, f: IncidentFilter = {}) {
  const rows = await db
    .select({
      key: sql<string>`coalesce(${incidents.phone}, ${incidents.lid})`,
      total: count(),
      last: sql<Date>`max(${incidents.createdAt})`,
    })
    .from(incidents)
    .where(and(where(f), sql`coalesce(${incidents.phone}, ${incidents.lid}) is not null`))
    .groupBy(sql`1`)
    .orderBy(desc(count()))
    .limit(50);
  return rows.map((r) => ({ key: r.key, total: Number(r.total), last: new Date(r.last) }));
}
