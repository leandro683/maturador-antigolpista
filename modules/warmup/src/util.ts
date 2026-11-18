import type { SQL } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { parseJid } from '@mag/shared/phone';

/** Execução de SQL cru, devolvendo linhas soltas. */
type Rows = Record<string, unknown>[];
type Ex = Pick<Db, 'execute'>;
export const exec = async (db: Ex, q: SQL) => (await db.execute(q)) as unknown as Rows;

export const TIME_ZONE = 'America/Sao_Paulo';

/** Erro de regra do maturador: a mensagem pode aparecer na tela. */
export class WarmupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WarmupError';
  }
}

/** Dia do custo (YYYY-MM-DD) em America/Sao_Paulo. */
export function appDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** O maturador gasta dinheiro de IA: só o dono configura. */
export function assertAdmin(role: string | null | undefined): void {
  if (role !== 'owner' && role !== 'admin') throw new WarmupError('Só o dono configura o maturador.');
}

/** O que vai para a tela. Erro de regra (WarmupError) aparece; erro cru (banco, rede) vira genérico e vai para o log. */
export function publicError(e: unknown, log: (e: unknown) => void = (x) => console.error('[warmup]', x)): string {
  if (e instanceof WarmupError) return e.message;
  log(e);
  return 'Não deu para salvar agora. Tente de novo em instantes.';
}

/** Conversa 1:1: usuário (c.us / s.whatsapp.net) ou LID. Grupo, status, canal e lista de transmissão ficam fora. */
export function isPrivateChat(chatId: string): boolean {
  const k = parseJid(chatId).kind;
  return k === 'user' || k === 'lid';
}
