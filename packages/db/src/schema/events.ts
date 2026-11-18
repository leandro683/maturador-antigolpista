import { mag } from './pg-schema';
import { sql } from 'drizzle-orm';
import { index, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { alertStatus } from './enums';
import { campaigns, groups, waAccounts } from './config';

export const alerts = mag.table(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    status: alertStatus('status').notNull().default('open'),
    waAccountId: uuid('wa_account_id').references(() => waAccounts.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('alerts_status_idx').on(t.status, t.createdAt),
    index('alerts_campaign_idx').on(t.campaignId),
    index('alerts_group_idx').on(t.groupId),
    index('alerts_wa_account_idx').on(t.waAccountId),
    /** dedupe dos alertas e varredura do aviso no WhatsApp */
    uniqueIndex('alerts_type_dedupe_key_uidx')
      .on(t.type, sql`(${t.data}->>'dedupeKey')`)
      .where(sql`${t.data} ? 'dedupeKey'`),
    index('alerts_type_created_idx').on(t.type, t.createdAt),
  ],
);
