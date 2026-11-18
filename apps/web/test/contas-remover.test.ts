import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createAccountsService } from '@mag/accounts';
import { waAccounts } from '@mag/db/schema';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import { FakeEngine } from '@mag/wa-engine/fake';

const h = vi.hoisted(() => ({ svc: null as unknown }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin' }) }));
vi.mock('@/server/services/accounts', () => ({
  NO_ENGINE_MESSAGE: 'sem motor',
  accountsService: async () => h.svc,
}));
const { removerContaAction } = await import('../app/(painel)/contas/actions');

describe.skipIf(!PG_URL)('remover conta: o aviso em português do serviço chega ao operador', () => {
  let t: Awaited<ReturnType<typeof freshDb>>;
  const engine = new FakeEngine();
  beforeAll(async () => {
    t = await freshDb();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.svc = createAccountsService(t.db, engine, { log: () => {} });
  });
  afterAll(async () => t?.drop());

  it('WhatsApp recusa encerrar a sessão → mensagem do serviço (não a genérica) e a conta fica', async () => {
    const svc = h.svc as ReturnType<typeof createAccountsService>;
    const conta = await svc.create({ name: 'Chip A' });
    const falha = vi.spyOn(engine, 'deleteSession').mockRejectedValueOnce(new Error('WAHA 500'));
    const r = await removerContaAction(conta.id);
    falha.mockRestore();
    expect(r).toEqual({
      ok: false,
      error: expect.stringContaining('Não foi possível encerrar a sessão no WhatsApp'),
    });
    expect(await t.db.select().from(waAccounts).where(eq(waAccounts.id, conta.id))).toHaveLength(1);
    // segunda tentativa, com o WhatsApp respondendo: remove
    expect(await removerContaAction(conta.id)).toEqual({ ok: true });
    expect(await t.db.select().from(waAccounts).where(eq(waAccounts.id, conta.id))).toHaveLength(0);
  });

  it('erro qualquer (banco, rede) segue com a mensagem genérica, sem vazar o texto', async () => {
    const svc = h.svc as ReturnType<typeof createAccountsService>;
    const conta = await svc.create({ name: 'Chip B' });
    vi.spyOn(svc, 'remove').mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    const r = await removerContaAction(conta.id);
    expect(r).toEqual({ ok: false, error: 'Não foi possível concluir. Tente de novo.' });
  });
});
