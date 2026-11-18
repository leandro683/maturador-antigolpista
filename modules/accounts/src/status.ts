/**
 * Estados de uma conta (+ `restricted`). Igual ao enum `mag.wa_account_status` (teste garante);
 * sem import do db p/ poder ir ao browser.
 */
export const ACC_STATUSES = [
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
  'imported', // conta importada, ainda sem sessão — parear
] as const;
export type AccStatus = (typeof ACC_STATUSES)[number];

/** Até 5 QRs (ciclos de pareamento do WAHA, ~5 min cada) antes de desistir. */
export const QR_CYCLE_MAX = 5;

export type StatusTone = 'ok' | 'warn' | 'bad' | 'idle';

export const STATUS_META: Record<AccStatus, { label: string; tone: StatusTone }> = {
  noStatus: { label: 'Sem sessão', tone: 'idle' },
  processing: { label: 'Iniciando', tone: 'warn' },
  active: { label: 'Ativa', tone: 'ok' },
  reconnecting: { label: 'Reconectando', tone: 'warn' },
  inactive: { label: 'Banida', tone: 'bad' },
  connected: { label: 'Conectada', tone: 'ok' },
  disconnected: { label: 'Desconectada', tone: 'idle' },
  pendingQrCode: { label: 'Aguardando QR', tone: 'warn' },
  needs_reauth: { label: 'Precisa reconectar', tone: 'bad' },
  restricted: { label: 'Restrita', tone: 'bad' },
  imported: { label: 'Importada (parear)', tone: 'idle' },
};

/** Abas Todas / Conectadas / Desconectadas / Sem sessão. */
export type StatusFilter = 'todas' | 'conectadas' | 'desconectadas' | 'sem-sessao';

export const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'todas', label: 'Todas' },
  { id: 'conectadas', label: 'Conectadas' },
  { id: 'desconectadas', label: 'Desconectadas' },
  { id: 'sem-sessao', label: 'Sem sessão' },
];

export function isConnected(s: AccStatus): boolean {
  return s === 'connected' || s === 'active' || s === 'restricted';
}

/**
 * Intervalo do refresh leve das telas de contas. Estado de transição ou sem sessão
 * (o usuário acabou de clicar "Conectar"/está pareando) → 5 s; conectada/banida → 30 s.
 */
export function refreshIntervalMs(s: AccStatus): number {
  return isConnected(s) || s === 'inactive' ? 30_000 : 5_000;
}

export function matchesFilter(s: AccStatus, f: StatusFilter): boolean {
  switch (f) {
    case 'todas':
      return true;
    case 'conectadas':
      return isConnected(s);
    case 'sem-sessao':
      return s === 'noStatus';
    case 'desconectadas':
      return !isConnected(s) && s !== 'noStatus';
  }
}

export function parseFilter(x: unknown): StatusFilter {
  return FILTERS.some((f) => f.id === x) ? (x as StatusFilter) : 'todas';
}
