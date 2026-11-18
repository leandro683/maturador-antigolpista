import { boolean, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { blacklistSource, mag } from '@mag/db/schema';

/** Visão do módulo: blacklists.campaign_ids/disabled, numbers.name, admin.lid. */
export const lists = mag.table('blacklists', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  campaignIds: uuid('campaign_ids')
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const numbers = mag.table('blacklist_numbers', {
  id: uuid('id').primaryKey().defaultRandom(),
  blacklistId: uuid('blacklist_id').notNull(),
  number: text('number'),
  lid: text('lid'),
  name: text('name'),
  source: blacklistSource('source').notNull().default('manual'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const admins = mag.table('admin_numbers', {
  id: uuid('id').primaryKey().defaultRandom(),
  number: text('number').notNull(),
  lid: text('lid'),
  label: text('label'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ListRow = typeof lists.$inferSelect;
export type NumberRow = typeof numbers.$inferSelect;
export type AdminRow = typeof admins.$inferSelect;
