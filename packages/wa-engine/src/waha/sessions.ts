/** Nome de sessão WAHA por conta + ciclo de QR (até 5 QRs por ciclo). */

export const QR_MAX_ATTEMPTS = 5;

/** WAHA aceita [a-zA-Z0-9_-]; usa o uuid da conta sem hífens. */
export function sessionNameFor(accountId: string): string {
  const clean = accountId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (!clean) throw new Error('accountId inválido');
  return `mag_${clean}`;
}

export class QrCycleExhaustedError extends Error {
  constructor(public readonly session: string) {
    super(`ciclo de ${QR_MAX_ATTEMPTS} QRs esgotado para ${session}`);
    this.name = 'QrCycleExhaustedError';
  }
}

export class QrCycle {
  private attempts = new Map<string, number>();

  constructor(private readonly max = QR_MAX_ATTEMPTS) {}

  /** Consome uma tentativa; retorna o nº (1..max) ou lança ao passar do limite. */
  next(session: string): number {
    const n = (this.attempts.get(session) ?? 0) + 1;
    if (n > this.max) throw new QrCycleExhaustedError(session);
    this.attempts.set(session, n);
    return n;
  }

  current(session: string): number {
    return this.attempts.get(session) ?? 0;
  }

  /** Chamar em WORKING (pareou) ou quando o usuário pede novo ciclo. */
  reset(session: string): void {
    this.attempts.delete(session);
  }
}
