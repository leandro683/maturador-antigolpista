import postgres from 'postgres';
import { createDb, type Db } from '../src/client';
import { runMigrations } from '../src/migrate';

/** Banco descartável com todas as migrations aplicadas. Os testes que precisam de Postgres pulam sem esta variável. */
export const PG_URL = process.env.TEST_DATABASE_URL;

/**
 * CREATE DATABASE e DROP DATABASE param para um checkpoint do Postgres. Com várias suítes (web, worker, módulos) e agentes
 * rodando juntos, dezenas de pedidos simultâneos levavam de 0,4 s a mais de 10 s cada e estouravam o tempo do
 * beforeAll/afterAll. Uma trava de aviso (mesma conexão do admin) faz criar/apagar um de cada vez, em qualquer processo.
 */
const LOCK_KEY = 7_270_001;
async function serial<T>(admin: postgres.Sql, fn: () => Promise<T>): Promise<T> {
  await admin`select pg_advisory_lock(${LOCK_KEY})`;
  try {
    return await fn();
  } finally {
    await admin`select pg_advisory_unlock(${LOCK_KEY})`;
  }
}

export async function freshDb(): Promise<{ db: Db; sql: postgres.Sql; drop: () => Promise<void> }> {
  const name = `mag_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = postgres(PG_URL!, { max: 1, onnotice: () => {} });
  const u = new URL(PG_URL!);
  u.pathname = `/${name}`;
  try {
    await serial(admin, async () => {
      await admin.unsafe(`CREATE DATABASE ${name}`);
      await runMigrations(u.toString());
    });
  } catch (e) {
    await admin.end();
    throw e;
  }
  const { db, sql } = createDb(u.toString(), { max: 2 });
  return {
    db,
    sql,
    drop: async () => {
      try {
        await sql.end();
        await serial(admin, () => admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
      } finally {
        await admin.end();
      }
    },
  };
}
