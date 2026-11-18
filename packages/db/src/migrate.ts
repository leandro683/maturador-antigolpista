import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';
import { MAG_SCHEMA } from './schema/pg-schema';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export async function runMigrations(url = process.env.DATABASE_URL) {
  const { db, sql } = createDb(url, { max: 1 });
  try {
    // tabela de controle dentro do próprio schema (não cria schema `drizzle` no banco)
    await migrate(db, {
      migrationsFolder: MIGRATIONS_DIR,
      migrationsSchema: MAG_SCHEMA,
      migrationsTable: '__drizzle_migrations',
    });
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations().then(
    () => console.log('migrations ok'),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
