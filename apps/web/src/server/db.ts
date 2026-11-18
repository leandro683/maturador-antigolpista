import 'server-only';
import { createDb, type Db } from '@mag/db';

/**
 * Conexão do painel — só em route handlers/server actions após checar auth.
 * Um pool por processo: cache em `globalThis` (no `next dev` cada rota compilada tem a própria instância do módulo e
 * um `let` local abriria um pool por rota → "too many clients").
 */
const g = globalThis as typeof globalThis & { __magServerDb?: Db };

export function serverDb(): Db {
  // vigia de 30 s (consulta enviada sem resposta): conexão perdida no pooler vira erro na tela em vez de travar o painel
  g.__magServerDb ??= createDb(process.env.DATABASE_URL, { max: 5, socketTimeoutSec: 30 }).db;
  return g.__magServerDb;
}
