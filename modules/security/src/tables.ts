import { boolean, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { mag } from '@mag/db/schema';

/** Tabelas de segurança (visão do módulo; o schema core não as conhece). */

/** Tipos de incidente; os `scan.*` são achados da varredura manual — abertos, sem ação. */
export const SCAN_KINDS = ['scan.blacklisted', 'scan.non-admin-message', 'scan.unknown-admin', 'scan.impersonator'] as const;
export type ScanKind = (typeof SCAN_KINDS)[number];
export const INCIDENT_KINDS = [
  'message',
  'promote',
  'admin_lost',
  'group_update',
  'blocked_join',
  'audit',
  /** mensagem revelada por reação */
  'reaction',
  ...SCAN_KINDS,
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];
export const INCIDENT_STATUSES = [
  'acted',
  'partial',
  'failed',
  'dry_run',
  'rate_limited',
  'ignored',
  'reverted',
  /** achado da varredura esperando o operador (Remover / Apagar / Ignorar) */
  'open',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export type Severity = 'info' | 'warning' | 'critical';
export type IncidentAction = { type: string; ok: boolean; target?: string; error?: string };

export const incidents = mag.table('security_incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id'),
  groupId: uuid('group_id'),
  waAccountId: uuid('wa_account_id'),
  gid: text('gid'),
  kind: text('kind').$type<IncidentKind>().notNull(),
  severity: text('severity').$type<Severity>().notNull().default('warning'),
  status: text('status').$type<IncidentStatus>().notNull().default('acted'),
  phone: text('phone'),
  lid: text('lid'),
  actor: text('actor'),
  messageId: text('message_id'),
  actions: jsonb('actions').$type<IncidentAction[]>().notNull().default([]),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  dedupKey: text('dedup_key').notNull(),
  resolvedBy: uuid('resolved_by'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const collaborators = mag.table('verified_collaborators', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull(),
  number: text('number'),
  lid: text('lid'),
  name: text('name'),
  source: text('source').$type<'manual' | 'csv' | 'account'>().notNull().default('manual'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = mag.table('collaborator_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull(),
  query: text('query').notNull(),
  number: text('number'),
  lid: text('lid'),
  result: boolean('result').notNull(),
  collaboratorId: uuid('collaborator_id'),
  checkedBy: uuid('checked_by'),
  channel: text('channel').$type<'painel' | 'publico' | 'api'>().notNull().default('painel'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const antiSpamGlobal = mag.table('anti_spam_global', {
  campaignId: uuid('campaign_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

/** Configurações globais (1 linha `id='global'`). */
export const securitySettings = mag.table('security_settings', {
  id: text('id').primaryKey().default('global'),
  value: jsonb('value').$type<Record<string, unknown>>().notNull().default({}),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type IncidentRow = typeof incidents.$inferSelect;
export type CollaboratorRow = typeof collaborators.$inferSelect;
export type VerificationRow = typeof verifications.$inferSelect;
