import { mag } from './pg-schema';
import { boolean, inet, integer, jsonb, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { actionStepStatus } from './enums';

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const groupParticipants = mag.table(
  'group_participants',
  {
    id: uuid('id').notNull().defaultRandom(),
    groupId: uuid('group_id').notNull(),
    phone: text('phone').notNull(),
    lid: text('lid'),
    isAdmin: boolean('is_admin').notNull().default(false),
    joinedAt: ts('joined_at'),
    leftAt: ts('left_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.phone] })],
);

export const actionSteps = mag.table('action_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  actionId: uuid('action_id').notNull(),
  groupId: uuid('group_id'),
  target: text('target'),
  status: actionStepStatus('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  result: jsonb('result').$type<Record<string, unknown>>(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Registro de auditoria. Retenção de 60 dias via delete_in. */
export const history = mag.table('history', {
  id: uuid('id').primaryKey().defaultRandom(),
  location: text('location').notNull(),
  type: text('type').notNull(),
  entityIds: text('entity_ids').array().notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  memberId: uuid('member_id'),
  ip: inet('ip'),
  deleteIn: ts('delete_in').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});
