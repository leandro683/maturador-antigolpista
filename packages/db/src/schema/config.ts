import { mag } from './pg-schema';
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { actionStatus, campaignType, waAccountStatus, waPlatform } from './enums';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export type RolePolicy = {
  role: 'creator' | 'sender' | 'both' | 'spy';
  maxGroupCreatesPerDay?: number;
  minSecondsBetweenCreates?: number;
  maxGroupSendsPerHour?: number;
  warmupFactor?: number;
};

export const waAccounts = mag.table(
  'wa_accounts',
  {
    id: id(),
    name: text('name').notNull(),
    jid: text('jid'),
    lid: text('lid'),
    platform: waPlatform('platform'),
    status: waAccountStatus('status').notNull().default('noStatus'),
    isAuthenticated: boolean('is_authenticated').notNull().default(false),
    lastConnectedAt: timestamp('last_connected_at', { withTimezone: true }),
    lastDisconnectReason: text('last_disconnect_reason'),
    qrAttempt: integer('qr_attempt').notNull().default(0),
    whatsappSuspension: jsonb('whatsapp_suspension').$type<Record<string, unknown> | null>(),
    reachoutTimelock: jsonb('reachout_timelock').$type<Record<string, unknown> | null>(),
    sessionName: text('session_name').notNull().unique(),
    rolePolicy: jsonb('role_policy').$type<RolePolicy>().notNull().default({ role: 'both' }),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('wa_accounts_status_idx').on(t.status)],
);

export type GroupTemplate = {
  name: string;
  image?: string | null;
  fixedDescription?: string | null;
  admins?: string[];
  limit: number;
  margin: number;
  countStart?: number;
  numberingPrefix?: string;
  numberPlacedOnStart?: boolean;
  onlyAdminsSpeak?: boolean;
  disappearingMessagesInChat?: number | null;
  alwaysAvailable: number;
  disabledGroupSpawn?: boolean;
  disabledMarkFullOnClicks?: boolean;
  groupCreationMode: 'normal' | 'safe';
  createOpenGroupAndCloseAfter?: boolean;
  joinApprovalOnCreate?: boolean;
  joinApprovalAutoDenyBlocked?: boolean;
  joinApprovalAutoApproveTagIds?: string[];
  maxGroupsPerLead?: number | null;
  /** dígitos do número no nome (`· 01` = 2); vazio = sem zero à esquerda */
  numberPad?: number | null;
  /** foto importada para o armazenamento (`image` fica com o link original) */
  imageRef?: GroupTemplateMedia | null;
  /** mensagem enviada pela conta criadora logo depois de configurar o grupo, antes do link */
  initialMessage?: { text: string; media?: GroupTemplateMedia | null } | null;
  /** tentar fixar a mensagem inicial por N dias (engine sem suporte devolve 501 → `settings.pinUnsupported`) */
  pinDays?: number | null;
  /** reenviar a mensagem inicial a cada N dias até `until` (YYYY-MM-DD, horário de São Paulo) */
  reinforcement?: { everyDays: number; until: string; time?: string; automationId?: string | null } | null;
};

/** Mídia em armazenamento (`path`) ou URL externa. */
export type GroupTemplateMedia = {
  path?: string;
  url?: string;
  mimetype: string;
  size: number;
  fileName?: string;
  uploadedAt: string;
};

export const DEFAULT_GROUP_TEMPLATE: GroupTemplate = {
  name: '',
  limit: 350,
  margin: 2,
  alwaysAvailable: 3,
  groupCreationMode: 'normal',
};

export const campaigns = mag.table(
  'campaigns',
  {
    id: id(),
    name: text('name').notNull(),
    type: campaignType('type').notNull().default('whats_release'),
    position: integer('position').notNull().default(0),
    pinned: boolean('pinned').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    accountIds: uuid('account_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    accountCreationIds: uuid('account_creation_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    slug: text('slug').notNull().unique(),
    deepLinking: boolean('deep_linking').notNull().default(false),
    enableRedirectCookie: boolean('enable_redirect_cookie').notNull().default(false),
    cookieTtlDays: integer('cookie_ttl_days').notNull().default(30),
    enableBotChallenge: boolean('enable_bot_challenge').notNull().default(false),
    pixels: jsonb('pixels').$type<Record<string, unknown>>().notNull().default({}),
    endAt: timestamp('end_at', { withTimezone: true }),
    endRedirectUrl: text('end_redirect_url'),
    groupTemplate: jsonb('group_template').$type<GroupTemplate>().notNull().default(DEFAULT_GROUP_TEMPLATE),
    periodicLinkUpdate: jsonb('periodic_link_update').$type<Record<string, unknown> | null>(),
    antiHacker: jsonb('anti_hacker').$type<Record<string, unknown> | null>(),
    /** flags sem coluna própria */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    /** contadores agregados para os cards */
    stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    reassignOnAccountRemoval: boolean('reassign_on_account_removal').notNull().default(true),
    /** quando foi fixada (a fixada por último fica no topo) */
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
  },
  (t) => [
    index('campaigns_archived_position_idx').on(t.archived, t.position),
    index('campaigns_updated_idx').on(t.archived, t.updatedAt.desc().nullsFirst()),
    index('campaigns_list_idx').on(
      t.archived,
      t.pinned.desc().nullsFirst(),
      t.position,
      t.createdAt.desc().nullsFirst(),
    ),
  ],
);

export const groups = mag.table(
  'groups',
  {
    id: id(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    waAccountId: uuid('wa_account_id').references(() => waAccounts.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    gid: text('gid').notNull().unique(),
    inviteCode: text('invite_code'),
    count: integer('count').notNull().default(0),
    full: boolean('full').notNull().default(false),
    filledAt: timestamp('filled_at', { withTimezone: true }),
    participantsAmount: integer('participants_amount').notNull().default(0),
    adminsAmount: integer('admins_amount').notNull().default(0),
    pendingAmount: integer('pending_amount').notNull().default(0),
    clicks: integer('clicks').notNull().default(0),
    clicksAmount: integer('clicks_amount').notNull().default(0),
    suspended: boolean('suspended').notNull().default(false),
    growthLocked: boolean('growth_locked').notNull().default(false),
    hiddenGroup: boolean('hidden_group').notNull().default(false),
    linkedParentId: uuid('linked_parent_id'),
    admins: jsonb('admins').$type<string[]>().notNull().default([]),
    /** descrição fixa e foto aplicadas no WhatsApp */
    description: text('description'),
    imageUrl: text('image_url'),
    /** estado extra */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('groups_campaign_full_count_idx').on(t.campaignId, t.full, t.count),
    index('groups_wa_account_idx').on(t.waAccountId),
    index('groups_campaign_count_idx').on(t.campaignId, t.count),
    index('groups_account_created_idx').on(t.waAccountId, t.createdAt.desc().nullsFirst()),
  ],
);

export const actions = mag.table(
  'actions',
  {
    id: id(),
    type: text('type').notNull(),
    parentId: uuid('parent_id'),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    waAccountId: uuid('wa_account_id').references(() => waAccounts.id, { onDelete: 'set null' }),
    refId: text('ref_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
    status: actionStatus('status').notNull().default('queued'),
    scheduledTo: timestamp('scheduled_to', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    total: integer('total').notNull().default(0),
    processed: integer('processed').notNull().default(0),
    success: integer('success').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    bullmqJobId: text('bullmq_job_id'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('actions_parent_idx').on(t.parentId),
    index('actions_status_scheduled_idx').on(t.status, t.scheduledTo),
    index('actions_campaign_idx').on(t.campaignId),
    index('actions_wa_account_idx').on(t.waAccountId),
  ],
);

/** Cache persistente LID → telefone (o engine manda participantes só com @lid). */
export const lidMap = mag.table(
  'lid_map',
  {
    lid: text('lid').primaryKey(),
    phone: text('phone').notNull(),
    source: text('source').notNull().default('event'),
    updatedAt: updatedAt(),
  },
  (t) => [index('lid_map_phone_idx').on(t.phone)],
);

/** Página pública /verificar/<slug> por campanha (slug próprio, ligada por padrão). */
export const collaboratorPages = mag.table(
  'collaborator_pages',
  {
    campaignId: uuid('campaign_id')
      .primaryKey()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    eventName: text('event_name'),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('collaborator_pages_slug_uidx').on(t.slug)],
);
