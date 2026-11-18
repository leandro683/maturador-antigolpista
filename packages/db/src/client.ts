import { drizzle } from 'drizzle-orm/postgres-js';
import net from 'node:net';
import postgres from 'postgres';
import * as schema from './schema/index';

export type Db = ReturnType<typeof createDb>['db'];

export const MAG_SEARCH_PATH = 'mag,public';

export type CreateDbOptions = {
  max?: number;
  /**
   * search_path da sessão. Queries do drizzle já saem qualificadas (`mag.x`);
   * use `MAG_SEARCH_PATH` p/ SQL cru sem prefixo. Ignorado atrás de pooler em modo transaction.
   */
  searchPath?: string;
  /**
   * Vigia opcional: derruba a conexão quando algo foi enviado depois da última resposta e nada chega em N s; a consulta
   * falha com CONNECTION_CLOSED em vez de pendurar e a próxima abre conexão nova. Desligado se omitido (migrations,
   * importador e consultas longas não têm limite).
   */
  socketTimeoutSec?: number;
  /** Intervalo da checagem do vigia (ms). Só para testes. */
  watchCheckMs?: number;
};

const DROP_MSG = 'banco sem resposta em';

const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);

/**
 * Socket com vigia "enviou e não voltou". Em poolers de conexão algumas conexões já abertas deixam
 * de responder (a consulta sai e nada volta, sem erro); sem isso a requisição esperava para sempre.
 * - Regra: houve envio depois da última resposta e nada chega em N s → conexão morta. Não olha o protocolo: conexão
 *   ociosa ou transação esperando outra coisa (ex.: chamada ao WhatsApp) não tem envio pendente e não é tocada.
 *   Consulta em fila atrás de uma resposta que já chegou só é notada no próximo envio (a conexão morta não responde mais).
 * - Devolve o socket na hora (sem Promise): falha ao conectar chega aos handlers do postgres.js, que liberam a vaga.
 * shortcut: com TLS o postgres.js remove os listeners e o vigia se desliga ao ver o SSLRequest (e
 * sslnegotiation=direct não é detectado); sem TLS o vigia vale normalmente.
 */
function watchedSocket(timeoutSec: number, checkMs = 1000) {
  return (o: { host: string[]; port: number[] }) => {
    const s = net.connect({ host: o.host[0] ?? 'localhost', port: o.port[0] ?? 5432 }) as net.Socket & { host?: string };
    s.host = o.host[0]; // servername do TLS (postgres.js lê socket.host)
    let off = false;
    // ordem dos eventos, não relógio: resposta e envio seguinte podem cair no mesmo milissegundo
    let pendingSince: number | null = null; // 1º envio depois da última resposta
    const write = s.write.bind(s) as (...a: unknown[]) => boolean;
    s.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (Buffer.isBuffer(chunk) && chunk.equals(SSL_REQUEST)) off = true;
      pendingSince ??= Date.now();
      return write(chunk, ...rest);
    }) as typeof s.write;
    s.on('data', () => {
      pendingSince = null;
    });
    const timer = setInterval(() => {
      if (s.destroyed || off) return clearInterval(timer);
      if (pendingSince !== null && Date.now() - pendingSince > timeoutSec * 1000) {
        clearInterval(timer);
        console.warn(`[db] ${DROP_MSG} ${timeoutSec}s: conexão descartada pelo vigia`);
        // sem erro de propósito: no postgres.js 3.4.9, close com erro (hadError) não rejeita consultas que entraram
        // na fila no meio da queda e elas penduram; close sem erro rejeita todas com CONNECTION_CLOSED e reconecta
        s.destroy();
      }
    }, checkMs);
    timer.unref();
    return s;
  };
}

/**
 * O postgres.js busca os tipos de array logo após conectar sem tratar a rejeição: se a conexão cai nesse momento
 * (vigia ou rede), vira unhandledRejection CONNECTION_CLOSED, que derrubaria o worker. Só instala quando ninguém mais
 * trata (o Next já trata e só registra); outros erros seguem o padrão do Node (derrubar o processo).
 */
function guardWatchdogRejections() {
  if (process.listenerCount('unhandledRejection') > 0) return;
  process.on('unhandledRejection', (e) => {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === 'CONNECTION_CLOSED' || code === 'CONNECTION_DESTROYED') {
      console.warn(`[db] consulta interna perdida na queda da conexão: ${e instanceof Error ? e.message : code}`);
      return;
    }
    setImmediate(() => {
      throw e;
    });
  });
}

/** Conexão server-side (DATABASE_URL). Nunca usar no browser. */
export function createDb(url = process.env.DATABASE_URL, opts: CreateDbOptions = {}) {
  if (!url) throw new Error('DATABASE_URL ausente');
  if (opts.socketTimeoutSec) guardWatchdogRejections();
  const sql = postgres(url, {
    max: opts.max ?? 10,
    prepare: false,
    // sem limite, uma conexão perdida em pooler pendura a requisição para sempre em vez de dar erro
    connect_timeout: 10,
    idle_timeout: 60,
    max_lifetime: 30 * 60,
    // `socket` existe no postgres.js 3.4 (src/connection.js createSocket) mas falta nos tipos
    ...(opts.socketTimeoutSec ? ({ socket: watchedSocket(opts.socketTimeoutSec, opts.watchCheckMs) } as object) : {}),
    ...(opts.searchPath ? { connection: { search_path: opts.searchPath } } : {}),
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
