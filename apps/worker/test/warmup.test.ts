import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WarmupDeps } from '@mag/module-warmup';
import type { waAccounts } from '@mag/db/schema';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import type { Db } from '@mag/db';
import { seedAccount } from './helpers';
import { closeWarmupQueue, WARMUP_JOB, WARMUP_QUEUE, warmupDeps, withWarmupHandlers } from '../src/processors/warmup';
import type { WaEventCtx, WaEventHandlers } from '../src/processors/wa-events';

const pair = { accountId: 'a1', peerId: 'a2', pairId: 'p1' };
const msg = (over: Record<string, unknown> = {}) => ({
  kind: 'message.in' as const,
  session: 's1',
  id: 'm1',
  chatId: '5511999990001@c.us',
  from: '5511999990001@c.us',
  fromMe: false,
  body: 'oi',
  hasMedia: false,
  ts: Date.now(),
  ...over,
});
const ctx = (raw: unknown = null, stale = false) => ({ raw, stale }) as unknown as WaEventCtx;

function setup(found: typeof pair | null) {
  const base = vi.fn(async () => ({ note: 'base' }));
  const match = vi.fn(async () => found);
  const incoming = vi.fn(async () => {});
  const h = withWarmupHandlers({ 'message.in': base } as unknown as WaEventHandlers, {
    db: {} as never,
    deps: {} as WarmupDeps,
    match: match as never,
    incoming: incoming as never,
  });
  const run = (e: unknown, c: WaEventCtx) => (h['message.in'] as (e: unknown, c: WaEventCtx) => Promise<unknown>)(e, c);
  return { base, match, incoming, run };
}

describe('maturador: filtro do message.in', () => {
  it('par por @c.us: não chama o base e chama onIncoming', async () => {
    const t = setup(pair);
    expect(await t.run(msg(), ctx())).toEqual({ handled: true });
    expect(t.base).not.toHaveBeenCalled();
    expect(t.incoming).toHaveBeenCalledWith(expect.anything(), { ...pair, fromMe: false, text: 'oi' });
  });

  it('par por @lid: passa o telefone alternativo (SenderAlt)', async () => {
    const t = setup(pair);
    const raw = { payload: { _data: { Info: { SenderAlt: `5511999990001:12@${'s.whatsapp.net'}` } } } };
    await t.run(msg({ chatId: '100000000000001@lid' }), ctx(raw));
    expect(t.match).toHaveBeenCalledWith({}, { session: 's1', chatId: '100000000000001@lid', altPhone: '5511999990001' });
    expect(t.base).not.toHaveBeenCalled();
  });

  it('fromMe: o chat é payload.to e o alt é RecipientAlt', async () => {
    const t = setup(pair);
    const raw = {
      payload: { to: '5511999990002@c.us', _data: { Info: { RecipientAlt: '5511999990002@s.whatsapp.net' } } },
    };
    await t.run(msg({ fromMe: true, chatId: '5511999990009@c.us' }), ctx(raw));
    expect(t.match).toHaveBeenCalledWith({}, { session: 's1', chatId: '5511999990002@c.us', altPhone: '5511999990002' });
    expect(t.incoming).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fromMe: true }));
  });

  it('número comum: segue para o base', async () => {
    const t = setup(null);
    expect(await t.run(msg(), ctx())).toEqual({ note: 'base' });
    expect(t.base).toHaveBeenCalledTimes(1);
    expect(t.incoming).not.toHaveBeenCalled();
  });

  it('grupo: passa direto, sem consultar o par', async () => {
    const t = setup(pair);
    await t.run(msg({ chatId: '1203630000000001@g.us' }), ctx());
    expect(t.match).not.toHaveBeenCalled();
    expect(t.base).toHaveBeenCalledTimes(1);
  });

  it('erro do onIncoming só loga e a mensagem continua consumida', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = setup(pair);
    t.incoming.mockRejectedValueOnce(new Error('x'));
    expect(await t.run(msg(), ctx())).toEqual({ handled: true });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('evento atrasado de par: consumido, sem onIncoming', async () => {
    const t = setup(pair);
    expect(await t.run(msg(), ctx(null, true))).toEqual({ handled: true });
    expect(t.incoming).not.toHaveBeenCalled();
    expect(t.base).not.toHaveBeenCalled();
  });

  describe('message.ack', () => {
    const ack = { kind: 'message.ack' as const, session: 's1', id: 'm1', chatId: '5511999990001@c.us', ack: 3, ts: 1 };
    const build = (found: typeof pair | null) => {
      const base = vi.fn(async () => ({ note: 'base' }));
      const match = vi.fn(async () => found);
      const h = withWarmupHandlers({ 'message.ack': base } as unknown as WaEventHandlers, {
        db: {} as never,
        deps: {} as WarmupDeps,
        match: match as never,
      });
      const run = (e: unknown) => (h['message.ack'] as (e: unknown, c: WaEventCtx) => Promise<unknown>)(e, ctx());
      return { base, run };
    };
    it('ack entre chips de um par: consumido, sem chegar ao base', async () => {
      const t = build(pair);
      expect(await t.run(ack)).toEqual({ handled: true });
      expect(t.base).not.toHaveBeenCalled();
    });
    it('ack de número comum: segue para o base', async () => {
      const t = build(null);
      expect(await t.run(ack)).toEqual({ note: 'base' });
      expect(t.base).toHaveBeenCalledOnce();
    });
  });
});

const mods = (over: Record<string, unknown> = {}) =>
  ({
    db: { execute: async () => [{ session_name: 's1', jid: '5511999990001@c.us' }] },
    engine: { send: vi.fn(async () => ({})) },
    connection: {},
    ...over,
  }) as never;

describe.skipIf(!PG_URL)('maturador: chipState (Postgres real)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await freshDb());
  });
  afterAll(async () => drop?.());

  const state = async (over: Partial<typeof waAccounts.$inferInsert> | null) => {
    const id = over ? (await seedAccount(db, null, over)).id : '00000000-0000-4000-8000-000000000000';
    return warmupDeps({ db, engine: {} as never, connection: {} as never }).chipState(id);
  };

  it('ok / restrito / desconectado / sem permissão / conta inexistente', async () => {
    expect(await state({})).toBe('ok');
    expect(await state({ status: 'restricted' })).toBe('restrito');
    const lock = { endsAt: new Date(Date.now() + 3600_000).toISOString() };
    expect(await state({ reachoutTimelock: lock })).toBe('restrito');
    expect(await state({ status: 'disconnected' })).toBe('desconectado');
    expect(await state({ rolePolicy: { role: 'creator' } })).toBe('sem-permissao');
    expect(await state({ status: 'disconnected', rolePolicy: { role: 'creator' } })).toBe('desconectado');
    expect(await state(null)).toBe('desconectado');
  });
});

describe('maturador: warmupDeps', () => {
  it('send: manda texto da sessão de quem fala para o chat do outro', async () => {
    const m = mods();
    await warmupDeps(m).send({ from: 'a1', to: 'a2', text: 'oi' });
    expect((m as { engine: { send: unknown } }).engine.send).toHaveBeenCalledWith('s1', '5511999990001@c.us', { type: 'text', text: 'oi' });
  });

  it('send: chip sem número lança erro em português e não envia', async () => {
    const m = mods({ db: { execute: async () => [] } });
    await expect(warmupDeps(m).send({ from: 'a1', to: 'a2', text: 'oi' })).rejects.toThrow(/sem número/);
    expect((m as { engine: { send: ReturnType<typeof vi.fn> } }).engine.send).not.toHaveBeenCalled();
  });
});

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6399';
const probe = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
probe.on('error', () => {});
const up = await probe.connect().then(() => true, () => false);
probe.disconnect();

describe.skipIf(!up)('maturador: schedule em BullMQ real', () => {
  const prefix = `wtest-${randomUUID()}`; // único por execução: suítes em paralelo e workers reais não compartilham chaves
  const qConn = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const q = new Queue(WARMUP_QUEUE, { connection: qConn, prefix });
  const depsConn = new Redis(redisUrl, { maxRetriesPerRequest: null });
  afterAll(async () => {
    await q.obliterate({ force: true });
    await q.close();
    qConn.disconnect();
    await closeWarmupQueue();
    depsConn.disconnect();
  });

  it('line e reply entram na fila com jobId pontuado e delay em ms', async () => {
    const deps = warmupDeps({ ...(mods() as object), connection: depsConn, prefix } as never);
    await deps.schedule({ kind: 'line', conversationId: 'c-1', idx: 2 }, 30);
    await deps.schedule({ kind: 'reply', conversationId: 'c-1', speaker: 'a1', turn: 3 }, 0);
    const line = await q.getJob('warmup.c-1.2.line');
    const reply = await q.getJob('warmup.c-1.3.reply');
    expect(line?.name).toBe(WARMUP_JOB);
    expect(line?.opts.delay).toBe(30_000);
    expect(line?.opts.removeOnComplete).toBe(1000);
    expect(line?.opts.removeOnFail).toBe(1000);
    expect(line?.data).toEqual({ kind: 'line', conversationId: 'c-1', idx: 2 });
    expect(await line?.getState()).toBe('delayed');
    expect(reply?.opts.delay).toBe(0);
    // mesma fala duas vezes colapsa
    await deps.schedule({ kind: 'line', conversationId: 'c-1', idx: 2 }, 30);
    expect(await q.getJobCountByTypes('delayed', 'waiting')).toBe(2);
    // fala adiada por queda do chip entra de novo (id novo), mesmo com a original ainda na fila
    await deps.schedule({ kind: 'line', conversationId: 'c-1', idx: 2, downSince: new Date().toISOString() }, 60);
    expect(await q.getJobCountByTypes('delayed', 'waiting')).toBe(3);
  });
});
