import type { AccStatus } from './status';
import { QR_CYCLE_MAX } from './status';

/**
 * Máquina de estados de conexão. Pura: recebe o snapshot da conta + status do
 * engine e devolve o patch do `wa_accounts` e os efeitos (restart/stop no WAHA, outbox, alerta).
 * O service aplica patch + efeitos numa transação.
 */

export type Suspension = {
  suspended: boolean;
  kind: 'permanent' | 'temporary';
  reason: string | null;
  endsAt: string | null;
  detectedAt: string;
};

export type ConnSnapshot = {
  status: AccStatus;
  qrAttempt: number;
  isAuthenticated: boolean;
  reachoutTimelock: Record<string, unknown> | null;
  whatsappSuspension: Record<string, unknown> | null;
};

export type ConnPatch = Partial<{
  status: AccStatus;
  qrAttempt: number;
  isAuthenticated: boolean;
  lastConnectedAt: Date;
  lastDisconnectReason: string | null;
  whatsappSuspension: Suspension | null;
  reachoutTimelock: Record<string, unknown> | null;
}>;

/** Eventos de conta. Ainda não há fila de saída: o serviço ignora os efeitos `outbox` e `alert`. */
export type AccountOutboxEvent =
  | 'account.banned'
  | 'account.restricted'
  | 'account.paired'
  | 'account.qrcode.generated'
  | 'account.qrcode.expired'
  | 'account.logged-out';

export type Effect =
  | { type: 'restart' }
  | { type: 'stop' }
  | { type: 'sync_profile' }
  | { type: 'outbox'; event: AccountOutboxEvent; data?: Record<string, unknown> }
  | { type: 'alert'; alert: AccountOutboxEvent; data?: Record<string, unknown> };

export type Transition = { changed: boolean; patch: ConnPatch; effects: Effect[]; reason?: string };

const NONE: Transition = { changed: false, patch: {}, effects: [] };

export type FailureKind = 'banned' | 'temp_banned' | 'logged_out' | 'unknown';

/**
 * Motivo do FAILED (whatsmeow/GOWS): 401 logged out · 402 temp ban · 403 ban. Sem motivo = desconhecido.
 * `device removed` = aparelho desvinculado no celular.
 */
export function classifyFailure(reason?: string | null): FailureKind {
  if (!reason) return 'unknown';
  const r = reason.toLowerCase();
  if (/temp\w*[\s_-]*ban|\b402\b/.test(r)) return 'temp_banned';
  if (/\bban|\b403\b|suspend|blocked/.test(r)) return 'banned';
  if (/logged[\s_-]*out|device[\s_-]*removed|\b401\b|unpaired/.test(r)) return 'logged_out';
  return 'unknown';
}

function timelockActive(s: ConnSnapshot): boolean {
  return Boolean(s.reachoutTimelock && (s.reachoutTimelock as { isActive?: unknown }).isActive);
}

export function onEngineStatus(
  s: ConnSnapshot,
  engineStatus: string,
  reason: string | undefined,
  now: Date,
): Transition {
  switch (engineStatus) {
    case 'STARTING': {
      const status: AccStatus = s.isAuthenticated ? 'reconnecting' : 'processing';
      return s.status === status ? NONE : { changed: true, patch: { status }, effects: [] };
    }

    case 'SCAN_QR_CODE': {
      // WAHA repete o evento dentro do mesmo ciclo → só conta ao entrar em pendingQrCode
      if (s.status === 'pendingQrCode') return NONE;
      const attempt = s.qrAttempt + 1;
      if (attempt > QR_CYCLE_MAX) return qrExhausted(now);
      return {
        changed: true,
        patch: { status: 'pendingQrCode', qrAttempt: attempt, isAuthenticated: false },
        effects: [
          { type: 'outbox', event: 'account.qrcode.generated', data: { attempt, maxAttempts: QR_CYCLE_MAX } },
        ],
      };
    }

    case 'WORKING': {
      const status: AccStatus = timelockActive(s) ? 'restricted' : 'connected';
      const firstPair = !s.isAuthenticated;
      if (!firstPair && s.status === status) return NONE;
      return {
        changed: true,
        patch: {
          status,
          qrAttempt: 0,
          isAuthenticated: true,
          lastConnectedAt: now,
          lastDisconnectReason: null,
          ...(s.whatsappSuspension && (s.whatsappSuspension as Suspension).kind === 'temporary'
            ? { whatsappSuspension: null }
            : {}),
        },
        effects: [
          ...(firstPair ? [{ type: 'outbox', event: 'account.paired' } as const] : []),
          { type: 'sync_profile' },
        ],
      };
    }

    case 'FAILED':
      return onFailed(s, reason, now);

    case 'STOPPED': {
      // `processing` = restart em andamento (stop → start) ou conexão pedida: não é queda
      if (['disconnected', 'needs_reauth', 'inactive', 'processing', 'noStatus'].includes(s.status))
        return NONE;
      return {
        changed: true,
        patch: { status: 'disconnected', lastDisconnectReason: reason ?? 'stopped' },
        effects: [],
      };
    }

    default:
      return NONE;
  }
}

function qrExhausted(_now: Date): Transition {
  return {
    changed: true,
    patch: { status: 'needs_reauth', isAuthenticated: false, lastDisconnectReason: 'qr_expired' },
    effects: [
      { type: 'stop' },
      { type: 'outbox', event: 'account.qrcode.expired', data: { maxAttempts: QR_CYCLE_MAX } },
      { type: 'alert', alert: 'account.qrcode.expired', data: { maxAttempts: QR_CYCLE_MAX } },
    ],
  };
}

function onFailed(s: ConnSnapshot, reason: string | undefined, now: Date): Transition {
  const kind = classifyFailure(reason);
  if (kind === 'banned' || kind === 'temp_banned') {
    const temporary = kind === 'temp_banned';
    const suspension: Suspension = {
      suspended: true,
      kind: temporary ? 'temporary' : 'permanent',
      reason: reason ?? null,
      endsAt: null,
      detectedAt: now.toISOString(),
    };
    const event = temporary ? 'account.restricted' : 'account.banned';
    return {
      changed: true,
      patch: {
        status: temporary ? 'restricted' : 'inactive',
        whatsappSuspension: suspension,
        lastDisconnectReason: reason ?? kind,
      },
      effects: [
        { type: 'stop' },
        { type: 'outbox', event, data: { reason: reason ?? null } },
        { type: 'alert', alert: event, data: { reason: reason ?? null } },
      ],
      reason,
    };
  }

  if (s.isAuthenticated) {
    // sessão pareada caiu de vez (aparelho removido / logout remoto) → precisa novo QR
    return {
      changed: true,
      patch: { status: 'needs_reauth', isAuthenticated: false, lastDisconnectReason: reason ?? 'failed' },
      effects: [
        { type: 'outbox', event: 'account.logged-out', data: { reason: reason ?? null } },
        { type: 'alert', alert: 'account.logged-out', data: { reason: reason ?? null } },
      ],
      reason,
    };
  }

  if (s.status === 'pendingQrCode' || s.status === 'processing') {
    // QR expirou sem leitura (~5 min no GOWS) → próximo ciclo ou desiste na 5ª
    if (s.qrAttempt >= QR_CYCLE_MAX) return qrExhausted(now);
    return { changed: true, patch: { status: 'processing' }, effects: [{ type: 'restart' }], reason };
  }

  if (s.status === 'disconnected' || s.status === 'needs_reauth' || s.status === 'inactive') return NONE;
  return {
    changed: true,
    patch: { status: 'disconnected', lastDisconnectReason: reason ?? 'failed' },
    effects: [],
    reason,
  };
}
