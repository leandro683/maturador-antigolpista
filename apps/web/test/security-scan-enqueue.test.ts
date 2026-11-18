import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { actions, campaigns, groups, waAccounts } from '@mag/db/schema';
import { freshDb, PG_URL } from '@mag/db/test-pg';

const h = vi.hoisted(() => ({ db: null as unknown, add: null as unknown as (...a: unknown[]) => Promise<unknown> }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => ({ get: () => null }) }));
vi.mock('@/lib/auth', () => ({
  getSession: async () => ({ user: { id: '00000000-0000-4000-8000-000000000001' } }),
  requireAdmin: async () => ({ id: 'admin' }),
}));
vi.mock('@/server/db', () => ({ serverDb: () => h.db }));
vi.mock('@/server/engine', () => ({ serverEngine: () => null }));
vi.mock('@/server/queues', () => ({ serverQueue: () => ({ add: (...a: unknown[]) => h.add(...a) }) }));
const { addCollab, startGroupScan, verify } = await import('@/server/services/security');

describe.skipIf(!PG_URL)('analisar grupos (painel): fila fora do ar', () => {
  let t: Awaited<ReturnType<typeof freshDb>>;
  let camp: string;
  beforeAll(async () => {
    t = await freshDb();
    h.db = t.db as Db;
    const [a] = await t.db
      .insert(waAccounts)
      .values({ name: 'Chip', sessionName: 'mag_teste01', jid: '5511999990001@c.us', status: 'active' })
      .returning();
    const [c] = await t.db.insert(campaigns).values({ name: 'Operação', slug: 'op-fila', accountIds: [a!.id] }).returning();
    camp = c!.id;
    await t.db.insert(groups).values({ campaignId: camp, waAccountId: a!.id, name: 'G1', gid: '1203630000000001@g.us' });
  });
  afterAll(async () => t?.drop());

  it('o erro da fila sobe: a análise é cancelada e o operador lê a mensagem em português (nada fica "em andamento")', async () => {
    h.add = async () => Promise.reject(new Error('Connection is closed.'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await startGroupScan(camp, 10);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('a análise foi cancelada') });
    expect((r as { error: string }).error).not.toContain('Connection is closed');
    const rows = await t.db.select().from(actions).where(eq(actions.campaignId, camp));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.status === 'canceled')).toBe(true);
  });

  it('fila no ar: a análise é criada e o filho vai para a fila sec-scan', async () => {
    const queued: unknown[][] = [];
    h.add = async (...a) => void queued.push(a);
    const r = await startGroupScan(camp, 10);
    expect(r.ok).toBe(true);
    expect(queued).toHaveLength(1);
    expect(queued[0]![0]).toBe('scan');
  });

  it('operação que não é UUID é recusada antes de tocar no banco', async () => {
    expect(await addCollab("1' or '1'='1", '11999990000', 'Fulano', 'phone')).toEqual({ ok: false, error: 'operação inválida' });
    expect(await verify('xyz', '11999990000')).toEqual({ ok: false, error: 'operação inválida' });
  });

  it('erro de banco não vai para a tela: mensagem genérica (o detalhe fica no log)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const certo = h.db;
    h.db = {
      select: () => {
        throw Object.assign(new Error('relation "mag.campaigns" does not exist'), { code: '42P01' });
      },
    };
    try {
      const r = await startGroupScan(camp, 10);
      expect(r).toEqual({ ok: false, error: 'Não foi possível concluir agora. Tente de novo em instantes.' });
      expect(log).toHaveBeenCalled();
    } finally {
      h.db = certo;
    }
  });

  it('erro simples do Redis fora do ar (ioredis, sem code) também vira mensagem genérica', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const certo = h.db;
    h.db = {
      transaction: () => {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      },
    };
    try {
      const r = await startGroupScan(camp, 10);
      expect(r).toEqual({ ok: false, error: 'Não foi possível concluir agora. Tente de novo em instantes.' });
      expect(log).toHaveBeenCalled();
    } finally {
      h.db = certo;
    }
  });
});
