-- Estado inicial do banco do Maturador + Anti-golpista (schema `mag`).
-- Escrito à mão. RLS ligado em todas as tabelas e SEM policy: só o dono da conexão (servidor/worker) lê e escreve.
create schema if not exists mag;
--> statement-breakpoint
-- ── enums ─────────────────────────────────────────────────────
create type mag.wa_account_status as enum ('noStatus', 'processing', 'active', 'reconnecting', 'inactive', 'connected', 'disconnected', 'pendingQrCode', 'needs_reauth', 'restricted', 'imported');
--> statement-breakpoint
create type mag.wa_platform as enum ('smba', 'smbi');
--> statement-breakpoint
create type mag.campaign_type as enum ('whats_release', 'whats_list', 'whats_viral', 'whats_random');
--> statement-breakpoint
create type mag.action_status as enum ('queued', 'scheduled', 'processing', 'success', 'failed', 'paused', 'canceled');
--> statement-breakpoint
create type mag.action_step_status as enum ('pending', 'processing', 'success', 'failed', 'skipped');
--> statement-breakpoint
create type mag.alert_status as enum ('open', 'resolved');
--> statement-breakpoint
create type mag.blacklist_source as enum ('manual', 'csv', 'anti_hacker', 'import');
--> statement-breakpoint
-- ── núcleo ────────────────────────────────────────────────────
create table mag.wa_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  jid text,
  lid text,
  platform mag.wa_platform,
  status mag.wa_account_status not null default 'noStatus',
  is_authenticated boolean not null default false,
  last_connected_at timestamptz,
  last_disconnect_reason text,
  qr_attempt integer not null default 0,
  whatsapp_suspension jsonb,
  reachout_timelock jsonb,
  session_name text not null,
  role_policy jsonb not null default '{"role": "both"}'::jsonb,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wa_accounts_session_name_unique unique (session_name)
);
--> statement-breakpoint
create index wa_accounts_status_idx on mag.wa_accounts (status);
--> statement-breakpoint
create table mag.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type mag.campaign_type not null default 'whats_release',
  position integer not null default 0,
  pinned boolean not null default false,
  archived boolean not null default false,
  account_ids uuid[] not null default '{}'::uuid[],
  account_creation_ids uuid[] not null default '{}'::uuid[],
  slug text not null,
  deep_linking boolean not null default false,
  enable_redirect_cookie boolean not null default false,
  cookie_ttl_days integer not null default 30,
  enable_bot_challenge boolean not null default false,
  pixels jsonb not null default '{}'::jsonb,
  end_at timestamptz,
  end_redirect_url text,
  group_template jsonb not null default '{"name": "", "limit": 350, "margin": 2, "alwaysAvailable": 3, "groupCreationMode": "normal"}'::jsonb,
  periodic_link_update jsonb,
  anti_hacker jsonb,
  settings jsonb not null default '{}'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  reassign_on_account_removal boolean not null default true,
  pinned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaigns_slug_unique unique (slug)
);
--> statement-breakpoint
create index campaigns_archived_position_idx on mag.campaigns (archived, position);
--> statement-breakpoint
create index campaigns_updated_idx on mag.campaigns (archived, updated_at desc);
--> statement-breakpoint
create index campaigns_list_idx on mag.campaigns (archived, pinned desc, position, created_at desc);
--> statement-breakpoint
create table mag.groups (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references mag.campaigns (id) on delete cascade,
  wa_account_id uuid references mag.wa_accounts (id) on delete set null,
  name text not null,
  gid text not null,
  invite_code text,
  count integer not null default 0,
  "full" boolean not null default false,
  filled_at timestamptz,
  participants_amount integer not null default 0,
  admins_amount integer not null default 0,
  pending_amount integer not null default 0,
  clicks integer not null default 0,
  clicks_amount integer not null default 0,
  suspended boolean not null default false,
  growth_locked boolean not null default false,
  hidden_group boolean not null default false,
  linked_parent_id uuid,
  admins jsonb not null default '[]'::jsonb,
  description text,
  image_url text,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint groups_gid_unique unique (gid)
);
--> statement-breakpoint
create index groups_campaign_full_count_idx on mag.groups (campaign_id, "full", count);
--> statement-breakpoint
create index groups_wa_account_idx on mag.groups (wa_account_id);
--> statement-breakpoint
create index groups_campaign_count_idx on mag.groups (campaign_id, count);
--> statement-breakpoint
create index groups_account_created_idx on mag.groups (wa_account_id, created_at desc);
--> statement-breakpoint
create table mag.group_participants (
  id uuid not null default gen_random_uuid(),
  group_id uuid not null,
  phone text not null,
  lid text,
  is_admin boolean not null default false,
  joined_at timestamptz,
  left_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint group_participants_pkey primary key (group_id, phone)
);
--> statement-breakpoint
create index group_participants_lid_idx on mag.group_participants (lid);
--> statement-breakpoint
create index group_participants_phone_idx on mag.group_participants (phone);
--> statement-breakpoint
create table mag.alerts (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  status mag.alert_status not null default 'open',
  wa_account_id uuid references mag.wa_accounts (id) on delete cascade,
  group_id uuid references mag.groups (id) on delete cascade,
  campaign_id uuid references mag.campaigns (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
--> statement-breakpoint
create index alerts_status_idx on mag.alerts (status, created_at);
--> statement-breakpoint
create index alerts_campaign_idx on mag.alerts (campaign_id);
--> statement-breakpoint
create index alerts_group_idx on mag.alerts (group_id);
--> statement-breakpoint
create index alerts_wa_account_idx on mag.alerts (wa_account_id);
--> statement-breakpoint
create unique index alerts_type_dedupe_key_uidx on mag.alerts (type, (data ->> 'dedupeKey')) where data ? 'dedupeKey';
--> statement-breakpoint
create index alerts_type_created_idx on mag.alerts (type, created_at);
--> statement-breakpoint
create table mag.history (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  type text not null,
  entity_ids text[] not null,
  before jsonb,
  after jsonb,
  member_id uuid,
  ip inet,
  delete_in timestamptz not null default (now() + interval '60 days'),
  created_at timestamptz not null default now()
);
--> statement-breakpoint
create index history_created_idx on mag.history (created_at);
--> statement-breakpoint
create index history_delete_in_idx on mag.history (delete_in);
--> statement-breakpoint
create index history_entity_ids_gin on mag.history using gin (entity_ids);
--> statement-breakpoint
create index history_location_idx on mag.history (location, created_at);
--> statement-breakpoint
create index history_member_idx on mag.history (member_id, created_at);
--> statement-breakpoint
create index history_type_idx on mag.history (type);
--> statement-breakpoint
create table mag.lid_map (
  lid text primary key,
  phone text not null,
  source text not null default 'event',
  updated_at timestamptz not null default now()
);
--> statement-breakpoint
create index lid_map_phone_idx on mag.lid_map (phone);
--> statement-breakpoint
create table mag.actions (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  parent_id uuid,
  campaign_id uuid references mag.campaigns (id) on delete cascade,
  wa_account_id uuid references mag.wa_accounts (id) on delete set null,
  ref_id text,
  payload jsonb not null default '{}'::jsonb,
  options jsonb not null default '{}'::jsonb,
  status mag.action_status not null default 'queued',
  scheduled_to timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  total integer not null default 0,
  processed integer not null default 0,
  success integer not null default 0,
  failed integer not null default 0,
  skipped integer not null default 0,
  last_heartbeat_at timestamptz,
  bullmq_job_id text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
--> statement-breakpoint
create index actions_parent_idx on mag.actions (parent_id);
--> statement-breakpoint
create index actions_status_scheduled_idx on mag.actions (status, scheduled_to);
--> statement-breakpoint
create index actions_campaign_idx on mag.actions (campaign_id);
--> statement-breakpoint
create index actions_wa_account_idx on mag.actions (wa_account_id);
--> statement-breakpoint
create index actions_automation_idx on mag.actions ((options ->> 'automationId')) where options ? 'automationId';
--> statement-breakpoint
create index actions_root_type_created_idx on mag.actions (type, created_at desc) where parent_id is null;
--> statement-breakpoint
create index actions_wa_account_open_idx on mag.actions (wa_account_id) where status in ('queued', 'scheduled', 'processing', 'paused');
--> statement-breakpoint
create table mag.action_steps (
  id uuid primary key default gen_random_uuid(),
  action_id uuid not null,
  group_id uuid,
  target text,
  status mag.action_step_status not null default 'pending',
  attempts integer not null default 0,
  error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
--> statement-breakpoint
create index action_steps_action_status_idx on mag.action_steps (action_id, status);
--> statement-breakpoint
-- ── segurança (anti-golpista) ────────────────────────────────
create table mag.security_incidents (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references mag.campaigns (id) on delete cascade,
  group_id uuid references mag.groups (id) on delete set null,
  wa_account_id uuid references mag.wa_accounts (id) on delete set null,
  gid text,
  kind text not null,
  severity text not null default 'warning',
  status text not null default 'acted',
  phone text,
  lid text,
  actor text,
  message_id text,
  actions jsonb not null default '[]'::jsonb,
  details jsonb not null default '{}'::jsonb,
  dedup_key text not null,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint security_incidents_kind_check check (kind in ('message', 'promote', 'admin_lost', 'group_update', 'blocked_join', 'audit', 'reaction', 'scan.blacklisted', 'scan.non-admin-message', 'scan.unknown-admin', 'scan.impersonator')),
  constraint security_incidents_severity_check check (severity in ('info', 'warning', 'critical')),
  constraint security_incidents_status_check check (status in ('acted', 'partial', 'failed', 'dry_run', 'rate_limited', 'ignored', 'reverted', 'open'))
);
--> statement-breakpoint
create unique index security_incidents_dedup_uq on mag.security_incidents (dedup_key);
--> statement-breakpoint
create index security_incidents_created_idx on mag.security_incidents (created_at desc);
--> statement-breakpoint
create index security_incidents_campaign_idx on mag.security_incidents (campaign_id, created_at desc);
--> statement-breakpoint
create index security_incidents_group_idx on mag.security_incidents (group_id);
--> statement-breakpoint
create index security_incidents_account_idx on mag.security_incidents (wa_account_id);
--> statement-breakpoint
create index security_incidents_scan_group_idx on mag.security_incidents (group_id, kind) where kind in ('scan.blacklisted', 'scan.non-admin-message', 'scan.unknown-admin', 'scan.impersonator');
--> statement-breakpoint
create index security_incidents_scan_idx on mag.security_incidents ((details ->> 'scanId')) where kind in ('scan.blacklisted', 'scan.non-admin-message', 'scan.unknown-admin', 'scan.impersonator');
--> statement-breakpoint
create table mag.verified_collaborators (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references mag.campaigns (id) on delete cascade,
  number text,
  lid text,
  name text,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  constraint verified_collaborators_source_check check (source in ('manual', 'csv', 'account')),
  constraint verified_collaborators_key_ck check (number is not null or lid is not null)
);
--> statement-breakpoint
create unique index verified_collaborators_number_uq on mag.verified_collaborators (campaign_id, number) where number is not null;
--> statement-breakpoint
create unique index verified_collaborators_lid_uq on mag.verified_collaborators (campaign_id, lid) where lid is not null;
--> statement-breakpoint
create table mag.collaborator_verifications (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references mag.campaigns (id) on delete cascade,
  query text not null,
  number text,
  lid text,
  result boolean not null,
  collaborator_id uuid references mag.verified_collaborators (id) on delete set null,
  checked_by uuid,
  channel text not null default 'painel',
  created_at timestamptz not null default now(),
  constraint collaborator_verifications_channel_check check (channel in ('painel', 'publico', 'api'))
);
--> statement-breakpoint
create index collaborator_verifications_campaign_idx on mag.collaborator_verifications (campaign_id, created_at desc);
--> statement-breakpoint
create index collaborator_verifications_number_idx on mag.collaborator_verifications (campaign_id, number);
--> statement-breakpoint
create index collaborator_verifications_collab_idx on mag.collaborator_verifications (collaborator_id);
--> statement-breakpoint
create table mag.anti_spam_global (
  campaign_id uuid primary key references mag.campaigns (id) on delete cascade,
  enabled boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
--> statement-breakpoint
create table mag.security_settings (
  id text primary key default 'global',
  value jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint security_settings_id_check check (id = 'global'),
  constraint security_settings_value_check check (jsonb_typeof(value) = 'object')
);
--> statement-breakpoint
create table mag.collaborator_pages (
  campaign_id uuid primary key references mag.campaigns (id) on delete cascade,
  slug text not null,
  enabled boolean not null default true,
  event_name text,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint collaborator_pages_slug_check check (slug ~ '^[a-z0-9]{6,32}$')
);
--> statement-breakpoint
create unique index collaborator_pages_slug_uidx on mag.collaborator_pages (slug);
--> statement-breakpoint
-- ── lista negra ───────────────────────────────────────────────
create table mag.blacklists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  campaign_ids uuid[] not null default '{}'::uuid[],
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);
--> statement-breakpoint
create table mag.blacklist_numbers (
  id uuid primary key default gen_random_uuid(),
  blacklist_id uuid not null references mag.blacklists (id) on delete cascade,
  number text,
  lid text,
  name text,
  source mag.blacklist_source not null default 'manual',
  created_at timestamptz not null default now()
);
--> statement-breakpoint
create index blacklist_numbers_lid_idx on mag.blacklist_numbers (lid);
--> statement-breakpoint
create index blacklist_numbers_number_idx on mag.blacklist_numbers (number);
--> statement-breakpoint
create unique index blacklist_numbers_list_lid_uq on mag.blacklist_numbers (blacklist_id, lid) where lid is not null;
--> statement-breakpoint
create unique index blacklist_numbers_list_number_uq on mag.blacklist_numbers (blacklist_id, number) where number is not null;
--> statement-breakpoint
create table mag.admin_numbers (
  id uuid primary key default gen_random_uuid(),
  number text not null,
  lid text,
  label text,
  created_at timestamptz not null default now(),
  constraint admin_numbers_number_unique unique (number)
);
--> statement-breakpoint
create table mag.scam_reports (
  id uuid primary key default gen_random_uuid(),
  number text,
  lid text,
  reason text not null,
  evidence_path text,
  evidence_type text,
  reported_by uuid,
  created_at timestamptz not null default now(),
  constraint scam_reports_key_check check (number is not null or lid is not null)
);
--> statement-breakpoint
create index scam_reports_number_idx on mag.scam_reports (number);
--> statement-breakpoint
-- ── maturador (warmup) ────────────────────────────────────────
create table mag.warmup_settings (
  id smallint primary key default 1,
  enabled boolean not null default false,
  mode text not null default 'queue',
  model text not null default 'openai/gpt-6-luna',
  theme text not null default '',
  allowed text not null default '',
  forbidden text not null default 'links, vendas, preços, dinheiro, Pix, política, religião, números de telefone, e-mails, propaganda, palavrões',
  gap_min_sec integer not null default 45,
  gap_max_sec integer not null default 180,
  typing_cps integer not null default 5,
  pause_min_min integer not null default 10,
  pause_max_min integer not null default 40,
  turns_min integer not null default 6,
  turns_max integer not null default 14,
  window_start integer,
  window_end integer,
  daily_cap_usd numeric(10, 2) not null default 1.00,
  updated_at timestamptz not null default now(),
  free_models text[] not null default array['nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3.5-super-vl:free', 'google/gemma-4-26b-a4b-it:free', 'dots-studio/dots-3-note-preview:free', 'nvidia/nemotron-3.5-lightning:free', 'google/gemma-4-31b-it:free']::text[],
  paid_models text[] not null default array['mistralai/mistral-nemo', 'mistralai/mistral-small-24b-instruct-2501', 'z-ai/glm-5.3-flash']::text[],
  paid_backup boolean not null default true,
  active_cap integer not null default 3,
  paused_until timestamptz,
  pause_reason text,
  model_rr integer not null default 0,
  constraint warmup_settings_singleton_ck check (id = 1),
  constraint warmup_settings_mode_ck check (mode in ('queue', 'ai')),
  constraint warmup_settings_gap_min_ck check (gap_min_sec >= 15),
  constraint warmup_settings_gap_max_ck check (gap_max_sec >= gap_min_sec),
  constraint warmup_settings_cps_ck check (typing_cps between 1 and 20),
  constraint warmup_settings_pause_min_ck check (pause_min_min >= 1),
  constraint warmup_settings_pause_max_ck check (pause_max_min >= pause_min_min),
  constraint warmup_settings_turns_min_ck check (turns_min between 2 and 40),
  constraint warmup_settings_turns_max_ck check (turns_max between turns_min and 40),
  constraint warmup_settings_window_start_ck check (window_start between 0 and 23),
  constraint warmup_settings_window_end_ck check (window_end between 0 and 23),
  constraint warmup_settings_cap_ck check (daily_cap_usd > 0),
  constraint warmup_settings_active_cap_ck check (active_cap between 1 and 10)
);
--> statement-breakpoint
insert into mag.warmup_settings (id) values (1) on conflict do nothing;
--> statement-breakpoint
create table mag.warmup_chips (
  account_id uuid primary key references mag.wa_accounts (id) on delete cascade,
  active boolean not null default true,
  started_at timestamptz not null default now(),
  paused_reason text,
  created_at timestamptz not null default now(),
  paused_at timestamptz,
  contacts_confirmed_at timestamptz
);
--> statement-breakpoint
create table mag.warmup_pairs (
  id uuid primary key default gen_random_uuid(),
  account_a uuid not null references mag.wa_accounts (id) on delete cascade,
  account_b uuid not null references mag.wa_accounts (id) on delete cascade,
  active boolean not null default true,
  contacts_confirmed_at timestamptz,
  next_at timestamptz,
  created_at timestamptz not null default now(),
  constraint warmup_pairs_uq unique (account_a, account_b),
  constraint warmup_pairs_order_ck check (account_a < account_b)
);
--> statement-breakpoint
create table mag.warmup_themes (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  allowed text not null default '',
  avoid text not null default '',
  active boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
--> statement-breakpoint
insert into mag.warmup_themes (name, allowed, avoid, position) values
  ('Séries de TV', 'O que estão assistindo, o que acharam, qual personagem preferem, o que indicariam.', '', 0),
  ('Futebol brasileiro', 'Um torce para o Corinthians e o outro para a Chapecoense: jogos que lembram, jogadores favoritos, se já foram ao estádio e como foi.', 'a tragédia da Chapecoense', 1),
  ('Filmes de 2025 e 2026', 'O que viram no cinema ou em casa, o que acharam, o que querem ver.', '', 2),
  ('Viagens pelo Brasil', 'Lugares que conhecem ou querem conhecer, praias, serras, comidas que provaram.', '', 3),
  ('Viagens aos EUA', 'Cidades e parques que querem conhecer ou já foram, o que mais gostaram.', '', 4),
  ('Europa', 'Países que conhecem ou sonham conhecer, como imaginam a viagem.', '', 5),
  ('Ásia', 'Culturas e comidas que têm curiosidade, lugares que gostariam de ver.', '', 6),
  ('China', 'O que têm curiosidade de conhecer, comidas que já provaram.', '', 7),
  ('Japão', 'Cerejeiras, Tóquio, Kyoto, comida, animes que gostam.', '', 8),
  ('Paris', 'O que fariam lá, cafés, passeios, se já foram e como foi.', '', 9),
  ('Itália', 'Cidades que querem ver, massas favoritas, lembranças de viagem.', '', 10),
  ('Toscana', 'Florença, vinhedos, cidadezinhas: como imaginam ou como foi.', '', 11),
  ('Desenhos das antigas', 'Dragon Ball, Pokémon, Jiraiya, Caverna do Dragão: episódios que lembram, personagem favorito, nostalgia.', '', 12),
  ('Vôlei', 'Se jogam ou já jogaram, o que acham da seleção, vôlei de praia.', '', 13),
  ('Tênis', 'Se jogam, o que gostam de assistir, jogadores favoritos.', '', 14),
  ('Federer, Djokovic ou Nadal', 'Quem cada um acha o melhor e por quê: estilo, carisma, jogos que viram.', '', 15)
on conflict (name) do nothing;
--> statement-breakpoint
create table mag.warmup_conversations (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid not null references mag.warmup_pairs (id) on delete cascade,
  mode text not null,
  status text not null default 'active',
  lines jsonb not null default '[]'::jsonb,
  turns_target integer not null,
  turns_done integer not null default 0,
  last_speaker uuid,
  cost_usd numeric(12, 6) not null default 0,
  started_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  ended_at timestamptz,
  theme_id uuid references mag.warmup_themes (id) on delete set null,
  model text,
  paid boolean not null default false,
  constraint warmup_conversations_status_ck check (status in ('active', 'done', 'canceled'))
);
--> statement-breakpoint
create unique index warmup_conversations_active_uq on mag.warmup_conversations (pair_id) where status = 'active';
--> statement-breakpoint
create table mag.warmup_messages (
  id bigint generated by default as identity primary key,
  conversation_id uuid not null references mag.warmup_conversations (id) on delete cascade,
  from_account uuid not null,
  to_account uuid not null,
  body text not null,
  status text not null,
  error text,
  cost_usd numeric(12, 6) not null default 0,
  created_at timestamptz not null default now(),
  constraint warmup_messages_status_ck check (status in ('sent', 'failed'))
);
--> statement-breakpoint
create index warmup_messages_created_idx on mag.warmup_messages (created_at desc);
--> statement-breakpoint
-- ── RLS: ligado em tudo, sem policy ───────────────────────────
alter table mag.wa_accounts enable row level security;
--> statement-breakpoint
alter table mag.campaigns enable row level security;
--> statement-breakpoint
alter table mag.groups enable row level security;
--> statement-breakpoint
alter table mag.group_participants enable row level security;
--> statement-breakpoint
alter table mag.alerts enable row level security;
--> statement-breakpoint
alter table mag.history enable row level security;
--> statement-breakpoint
alter table mag.lid_map enable row level security;
--> statement-breakpoint
alter table mag.actions enable row level security;
--> statement-breakpoint
alter table mag.action_steps enable row level security;
--> statement-breakpoint
alter table mag.security_incidents enable row level security;
--> statement-breakpoint
alter table mag.verified_collaborators enable row level security;
--> statement-breakpoint
alter table mag.collaborator_verifications enable row level security;
--> statement-breakpoint
alter table mag.anti_spam_global enable row level security;
--> statement-breakpoint
alter table mag.security_settings enable row level security;
--> statement-breakpoint
alter table mag.collaborator_pages enable row level security;
--> statement-breakpoint
alter table mag.blacklists enable row level security;
--> statement-breakpoint
alter table mag.blacklist_numbers enable row level security;
--> statement-breakpoint
alter table mag.admin_numbers enable row level security;
--> statement-breakpoint
alter table mag.scam_reports enable row level security;
--> statement-breakpoint
alter table mag.warmup_settings enable row level security;
--> statement-breakpoint
alter table mag.warmup_chips enable row level security;
--> statement-breakpoint
alter table mag.warmup_pairs enable row level security;
--> statement-breakpoint
alter table mag.warmup_themes enable row level security;
--> statement-breakpoint
alter table mag.warmup_conversations enable row level security;
--> statement-breakpoint
alter table mag.warmup_messages enable row level security;
