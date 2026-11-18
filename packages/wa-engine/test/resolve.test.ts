import { describe, expect, it, vi } from 'vitest';
import { WahaClient } from '../src/waha/client';
import { MemoryLidStore } from '../src/waha/lid';
import { ChatIdResolver, phoneVariantsOf, WaNumberNotFoundError, withPhoneResolution } from '../src/waha/resolve';

/** Erro real devolvido pelo WAHA (GOWS). */
const NO_LID_BODY = JSON.stringify({
  statusCode: 500,
  message: 'no LID found for 5511999990002@s.whatsapp.net',
  error: 'Internal Server Error',
});

type Call = { method: string; path: string; body?: Record<string, unknown> };

/** WAHA fake: a conta do contato está registrada SEM o 9 (551199990002). */
function wahaOldVariant(opts: { lid?: string } = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method: init?.method ?? 'GET', path: u.pathname + u.search, body });
    if (u.pathname === '/api/contacts/check-exists') {
      const phone = u.searchParams.get('phone');
      const ok = phone === '551199990002';
      return Response.json(
        ok
          ? { numberExists: true, chatId: '551199990002@c.us', ...(opts.lid ? { lid: opts.lid } : {}) }
          : { numberExists: false },
      );
    }
    if (u.pathname === '/api/sendText') {
      if (body?.chatId === '5511999990002@c.us') return new Response(NO_LID_BODY, { status: 500 });
      return Response.json({ id: 'true_x_MSG1' });
    }
    if (u.pathname.endsWith('/participants/add')) {
      const ps = (body?.participants ?? []) as { id: string }[];
      return Response.json(ps.map((p) => ({ JID: p.id, Error: p.id.startsWith('5544998') ? 'not found' : undefined })));
    }
    return Response.json({});
  });
  const client = new WahaClient({ baseUrl: 'http://waha', fetch });
  return { client, calls };
}

describe('phoneVariantsOf', () => {
  it('c/ 9 primeiro; fixo/estrangeiro só ele', () => {
    expect(phoneVariantsOf('5511999990002')).toEqual(['5511999990002', '551199990002']);
    expect(phoneVariantsOf('551199990002')).toEqual(['5511999990002', '551199990002']);
    expect(phoneVariantsOf('551133330001')).toEqual(['551133330001']);
    expect(phoneVariantsOf('14155552671')).toEqual(['14155552671']);
  });
});

describe('ChatIdResolver / withPhoneResolution', () => {
  it('sem resolver reproduz o bug: WAHA 500 no LID found', async () => {
    const { client } = wahaOldVariant();
    await expect(client.send('chip-01', '5511999990002@c.us', { type: 'text', text: 'oi' })).rejects.toThrow(/no LID found/);
  });

  it('send por telefone canônico (c/ 9) vai p/ a variante registrada (s/ 9) e cacheia', async () => {
    const { client, calls } = wahaOldVariant();
    const eng = withPhoneResolution(client, new ChatIdResolver(client));
    for (const input of ['5511999990002@c.us', '551199990002@c.us']) {
      await expect(eng.send('chip-01', input, { type: 'text', text: 'oi' })).resolves.toEqual({ id: 'true_x_MSG1' });
    }
    const sends = calls.filter((c) => c.path === '/api/sendText').map((c) => c.body?.chatId);
    expect(sends).toEqual(['551199990002@c.us', '551199990002@c.us']);
    expect(calls.filter((c) => c.path.startsWith('/api/contacts/check-exists'))).toHaveLength(2); // 2 variantes, 1 vez
  });

  it('LID devolvido pelo checkNumber vai p/ o store (lid_map) e vira destino do send', async () => {
    const { client, calls } = wahaOldVariant({ lid: '100000000000001@lid' });
    const store = new MemoryLidStore();
    const eng = withPhoneResolution(client, new ChatIdResolver(client, { store }));
    await eng.send('chip-01', '5511999990002@c.us', { type: 'text', text: 'oi' });
    expect(store.map.get('100000000000001@lid')).toBe('+5511999990002');
    expect(calls.find((c) => c.path === '/api/sendText')?.body?.chatId).toBe('100000000000001@lid');
  });

  it('shape real do GOWS (validado em chip real): as 2 variantes "existem", pn = s/ 9, chatId = LID → send no LID', async () => {
    const calls: string[] = [];
    const client = new WahaClient({
      baseUrl: 'http://waha',
      fetch: async (url, init) => {
        const u = new URL(url);
        if (u.pathname === '/api/contacts/check-exists')
          return Response.json({ numberExists: true, chatId: '100000000000001@lid', pn: '551199990002@c.us' });
        calls.push(String((JSON.parse(String(init?.body)) as { chatId?: string }).chatId ?? u.pathname));
        return Response.json({ id: 'M' });
      },
    });
    const store = new MemoryLidStore();
    const resolver = new ChatIdResolver(client, { store });
    const eng = withPhoneResolution(client, resolver);
    await eng.send('chip-01', '5511999990002@c.us', { type: 'text', text: 'oi' });
    await eng.addParticipants('chip-01', '1203630000000001@g.us', ['5511999990002@c.us']);
    expect(calls).toEqual(['100000000000001@lid', '/api/chip-01/groups/1203630000000001%40g.us/participants/add']);
    expect((await resolver.resolve('chip-01', '+5511999990002', 'participant')).jid).toBe('551199990002@c.us');
    expect(store.map.get('100000000000001@lid')).toBe('+5511999990002');
  });

  it('LID já conhecido (store.byPhone) → send sem checkNumber', async () => {
    const { client, calls } = wahaOldVariant();
    const store = Object.assign(new MemoryLidStore(), {
      byPhone: async (phones: string[]) => new Map(phones.filter((p) => p === '+5511999990002').map((p) => [p, '100000000000005@lid'])),
    });
    const eng = withPhoneResolution(client, new ChatIdResolver(client, { store }));
    await eng.send('chip-01', '+5511999990002', { type: 'text', text: 'oi' });
    expect(calls.map((c) => c.path)).toEqual(['/api/sendText']);
    expect(calls[0]!.body?.chatId).toBe('100000000000005@lid');
  });

  it('addParticipants: resolve p/ variante real e devolve resultado no jid original', async () => {
    const { client, calls } = wahaOldVariant();
    const eng = withPhoneResolution(client, new ChatIdResolver(client));
    const r = await eng.addParticipants('chip-01', '1203630000000004@g.us', ['5511999990002@c.us']);
    expect(r).toEqual([{ jid: '5511999990002@c.us', ok: true }]);
    const add = calls.find((c) => c.path.endsWith('/participants/add'));
    expect(add?.body).toEqual({ participants: [{ id: '551199990002@c.us' }] });
  });

  it('número sem WhatsApp em nenhuma variante: send lança, add falha por jid', async () => {
    const { client } = wahaOldVariant();
    const eng = withPhoneResolution(client, new ChatIdResolver(client));
    await expect(eng.send('chip-01', '5511999990015@c.us', { type: 'text', text: 'x' })).rejects.toBeInstanceOf(
      WaNumberNotFoundError,
    );
    expect(await eng.addParticipants('chip-01', '1203630000000001@g.us', ['5511999990015@c.us'])).toEqual([
      { jid: '5511999990015@c.us', ok: false, error: 'número sem WhatsApp' },
    ]);
  });

  it('grupo e LID passam direto (sem checkNumber)', async () => {
    const { client, calls } = wahaOldVariant();
    const eng = withPhoneResolution(client, new ChatIdResolver(client));
    await eng.send('chip-01', '1203630000000004@g.us', { type: 'text', text: 'x' });
    await eng.send('chip-01', '100000000000006@lid', { type: 'text', text: 'x' });
    expect(calls.map((c) => c.body?.chatId)).toEqual(['1203630000000004@g.us', '100000000000006@lid']);
  });

  it('checkNumber fora do ar não bloqueia; no LID found → tenta a outra variante', async () => {
    const { client, calls } = wahaOldVariant();
    const broken = Object.assign(Object.create(client) as WahaClient, {
      checkNumber: async () => {
        throw new Error('timeout');
      },
    });
    const resolver = new ChatIdResolver(broken);
    const eng = withPhoneResolution(client, resolver);
    await expect(eng.send('chip-01', '5511999990002@c.us', { type: 'text', text: 'oi' })).resolves.toEqual({
      id: 'true_x_MSG1',
    });
    expect(calls.filter((c) => c.path === '/api/sendText').map((c) => c.body?.chatId)).toEqual([
      '5511999990002@c.us',
      '551199990002@c.us',
    ]);
    // aprendeu: próximo envio direto na variante certa
    expect((await resolver.resolve('chip-01', '5511999990002@c.us')).jid).toBe('551199990002@c.us');
  });

  it('cache negativo expira', async () => {
    let now = 0;
    const engine = { checkNumber: vi.fn(async () => ({ exists: false })) };
    const r = new ChatIdResolver(engine, { now: () => now, negativeTtlMs: 1000 });
    await r.resolve('s', '5511999990015');
    await r.resolve('s', '5511999990015');
    expect(engine.checkNumber).toHaveBeenCalledTimes(2); // 2 variantes, cacheado
    now = 2000;
    await r.resolve('s', '5511999990015');
    expect(engine.checkNumber).toHaveBeenCalledTimes(4);
  });
});
