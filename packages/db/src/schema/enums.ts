import { mag } from './pg-schema';

export const waAccountStatus = mag.enum('wa_account_status', [
  'noStatus',
  'processing',
  'active',
  'reconnecting',
  'inactive',
  'connected',
  'disconnected',
  'pendingQrCode',
  'needs_reauth',
  'restricted',
  'imported',
]);

export const waPlatform = mag.enum('wa_platform', ['smba', 'smbi']);

export const campaignType = mag.enum('campaign_type', ['whats_release', 'whats_list', 'whats_viral', 'whats_random']);

export const actionStatus = mag.enum('action_status', [
  'queued',
  'scheduled',
  'processing',
  'success',
  'failed',
  'paused',
  'canceled',
]);

export const actionStepStatus = mag.enum('action_step_status', ['pending', 'processing', 'success', 'failed', 'skipped']);

export const alertStatus = mag.enum('alert_status', ['open', 'resolved']);

export const blacklistSource = mag.enum('blacklist_source', ['manual', 'csv', 'anti_hacker', 'import']);
