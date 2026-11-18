import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations } from '../src/migrate';
import { waAccounts } from '../src/schema/index';
import { freshDb, PG_URL } from './pg';

const TABLES = [
  'wa_accounts',
  'campaigns',
  'groups',
  'group_participants',
  'alerts',
  'history',
  'lid_map',
  'actions',
  'action_steps',
  'security_incidents',
  'verified_collaborators',
  'collaborator_verifications',
  'anti_spam_global',
  'security_settings',
  'collaborator_pages',
  'blacklists',
  'blacklist_numbers',
  'admin_numbers',
  'scam_reports',
  'warmup_settings',
  'warmup_chips',
  'warmup_pairs',
  'warmup_conversations',
  'warmup_messages',
  'warmup_themes',
];

describe.skipIf(!PG_URL)('migrations aplicam em Postgres real', () => {
  let ctx: Awaited<ReturnType<typeof freshDb>>;
  let url = '';

  beforeAll(async () => {
    ctx = await freshDb();
    const [{ db }] = (await ctx.sql`SELECT current_database() AS db`) as unknown as [{ db: string }];
    const u = new URL(PG_URL!);
    u.pathname = `/${db}`;
    url = u.toString();
  });

  afterAll(async () => {
    await ctx?.drop();
  });

  it('aplicar de novo não falha', async () => {
    await expect(runMigrations(url)).resolves.toBeUndefined();
    const rows = await ctx.sql`SELECT count(*)::int AS n FROM mag.__drizzle_migrations`;
    expect(rows[0]!.n).toBe(1);
  });

  it('todas as tabelas existem em mag e nada vai para public', async () => {
    const found = await ctx.sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'mag'`;
    const names = found.map((r) => r.table_name as string);
    for (const t of TABLES) expect(names, t).toContain(t);
    const pub = await ctx.sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`;
    expect(pub[0]!.n).toBe(0);
  });

  it('RLS ligado e sem policy em todas as tabelas', async () => {
    const off = await ctx.sql`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'mag' AND c.relkind = 'r' AND c.relname <> '__drizzle_migrations' AND NOT c.relrowsecurity`;
    expect(off).toEqual([]);
    const pol = await ctx.sql`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'mag'`;
    expect(pol[0]!.n).toBe(0);
  });

  it('insert/select em wa_accounts (drizzle) com os padrões', async () => {
    const [row] = await ctx.db
      .insert(waAccounts)
      .values({ name: 'Chip 01', sessionName: 'chip-01' })
      .returning();
    expect(row!.status).toBe('noStatus');
    expect(row!.rolePolicy).toEqual({ role: 'both' });
    const back = await ctx.db.select().from(waAccounts).where(eq(waAccounts.sessionName, 'chip-01'));
    expect(back).toHaveLength(1);
  });

  it('warmup_settings nasce com a linha inicial e temas padrão', async () => {
    const s = await ctx.sql`SELECT id, enabled, mode, active_cap FROM mag.warmup_settings`;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: 1, enabled: false, mode: 'queue', active_cap: 3 });
    const t = await ctx.sql`SELECT count(*)::int AS n FROM mag.warmup_themes`;
    expect(t[0]!.n).toBe(16);
  });

  it('security_incidents aceita os tipos finais (reaction, scan.impersonator) e status open', async () => {
    await ctx.sql`INSERT INTO mag.security_incidents (kind, status, dedup_key) VALUES ('reaction', 'open', 'k1'), ('scan.impersonator', 'open', 'k2')`;
    await expect(
      ctx.sql`INSERT INTO mag.security_incidents (kind, dedup_key) VALUES ('invalido', 'k3')`,
    ).rejects.toThrow();
  });
});
