import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { Db } from '@mag/db';
import type { ChatInput, ChatResult, LlmClient } from '@mag/llm';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import { addChip, addPair, setEnabled, activeConversationOf, confirmPair, getSettings, saveSettings, paidCostToday, syncPairs } from '../src/repo';
import { FREE_DEFAULT, PAID_DEFAULT } from '../src/models';
import { askChain, DOWN_RETRY_SEC, modelChain, nextResetUtc, onIncoming, pauseAll, runJob, tick, type ChipState, type WarmupDeps, type WarmupJob } from '../src/engine';

const SCRIPT = 'A: oi, tudo bem?\nB: tudo ótimo, e você?\nA: também, vou ler hoje\nB: boa leitura!';

function fakeLlm(texts: string[], cost: number | null = 0.001) {
  let i = 0;
  const chat = vi.fn(
    async (_i: ChatInput): Promise<ChatResult> => ({
      provider: 'openrouter',
      model: 'fake',
      text: texts[Math.min(i++, texts.length - 1)]!,
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 10, outputTokens: 10, costUsd: cost },
      ms: 1,
    }),
  );
  const client: LlmClient = { config: { provider: 'openrouter', model: 'fake', apiKey: 'x', timeoutMs: 1000, retries: 0 }, chat };
  return { client, chat };
}

describe.skipIf(!PG_URL)('motor do maturador', () => {
  let db: Db;
  let sql: postgres.Sql;
  let drop: () => Promise<void>;
  let a = '';
  let b = '';
  let pairId = '';
  let llm = fakeLlm([SCRIPT]);
  /** por slug: sem entrada = llm padrão; 'erro' = lança */
  let bySlug: Record<string, ReturnType<typeof fakeLlm> | 'erro'> = {};
  let now = new Date('2026-11-07T15:00:00Z');
  const sent: { from: string; to: string; text: string }[] = [];
  const jobs: { job: WarmupJob; delay: number }[] = [];
  let state: (id: string) => ChipState = () => 'ok';
  let sendFail = false;
  const deps = (): WarmupDeps => ({
    db,
    llm: (slug) => {
      const f = bySlug[slug];
      if (f === 'erro') return { ...llm.client, chat: async () => { throw new Error('429'); } };
      return (f ?? llm).client;
    },
    send: async (o) => {
      if (sendFail) throw new Error('boom');
      sent.push(o);
    },
    chipState: async (id) => state(id),
    schedule: async (job, delay) => void jobs.push({ job, delay }),
    now: () => now,
    rnd: () => 0,
    log: () => {},
  });

  beforeAll(async () => {
    ({ db, sql, drop } = await freshDb());
    const ids: string[] = [];
    for (const i of [1, 2]) {
      const [r] = await sql`INSERT INTO mag.wa_accounts (name, session_name, status, jid)
        VALUES (${'Conta ' + i}, ${'sess' + i}, 'connected', ${`55119999900${'0' + i}@c.us`}) RETURNING id`;
      ids.push(String(r!.id));
      await addChip(db, String(r!.id));
    }
    [a, b] = ids.sort() as [string, string];
    pairId = await addPair(db, a, b);
    await confirmPair(db, pairId);
  });
  afterAll(async () => drop?.());
  beforeEach(async () => {
    await sql`DELETE FROM mag.warmup_messages`;
    await sql`DELETE FROM mag.warmup_conversations`;
    await sql`UPDATE mag.warmup_pairs SET next_at = NULL`;
    await sql`UPDATE mag.warmup_chips SET active = true, paused_reason = NULL, contacts_confirmed_at = now()`;
    await sql`UPDATE mag.warmup_themes SET active = true`;
    await sql`UPDATE mag.warmup_settings SET paused_until = NULL, pause_reason = NULL`;
    const s = await getSettings(db);
    await saveSettings(db, { ...s, enabled: true, mode: 'queue', windowStart: null, windowEnd: null, dailyCapUsd: 1, freeModels: FREE_DEFAULT, paidModels: PAID_DEFAULT, paidBackup: true, activeCap: 3, turnsMin: 4, turnsMax: 4 });
    await setEnabled(db, true);
    llm = fakeLlm([SCRIPT]);
    bySlug = {};
    sent.length = 0;
    jobs.length = 0;
    state = () => 'ok';
    sendFail = false;
    now = new Date('2026-11-07T15:00:00Z');
  });

  const nextAt = async () => {
    const [r] = await sql`SELECT next_at FROM mag.warmup_pairs WHERE id = ${pairId}`;
    return r!.next_at ? new Date(r!.next_at as string) : null;
  };
  const convStatus = async () => {
    const [r] = await sql`SELECT status FROM mag.warmup_conversations ORDER BY started_at DESC LIMIT 1`;
    return r?.status as string | undefined;
  };

  it('queue fim a fim', async () => {
    expect(await tick(deps())).toEqual({ started: 1, canceled: 0 });
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job).toMatchObject({ kind: 'line', idx: 0 });
    expect(jobs[0]!.delay).toBeGreaterThanOrEqual(15);
    for (let i = 0; i < 4; i++) {
      const job = jobs.shift()!.job;
      expect(await runJob(deps(), job)).toBe('sent');
      if (i < 3) {
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.job).toMatchObject({ kind: 'line', idx: i + 1 });
        expect(jobs[0]!.delay).toBeGreaterThanOrEqual(15);
      }
    }
    expect(sent.map((m) => [m.from, m.to, m.text])).toEqual([
      [a, b, 'oi, tudo bem?'],
      [b, a, 'tudo ótimo, e você?'],
      [a, b, 'também, vou ler hoje'],
      [b, a, 'boa leitura!'],
    ]);
    expect(jobs).toHaveLength(0);
    expect(await convStatus()).toBe('done');
    const min = ((await nextAt())!.getTime() - now.getTime()) / 60_000;
    expect(min).toBeGreaterThanOrEqual(10);
    expect(min).toBeLessThanOrEqual(40);
  });

  it('idx repetido é skipped', async () => {
    await tick(deps());
    const job = jobs.shift()!.job;
    expect(await runJob(deps(), job)).toBe('sent');
    expect(await runJob(deps(), job)).toBe('skipped');
    expect(sent).toHaveLength(1);
  });

  it('chip restrito no meio desliga o chip e cancela', async () => {
    await tick(deps());
    state = (id) => (id === b ? 'restrito' : 'ok');
    expect(await runJob(deps(), jobs.shift()!.job)).toBe('ended');
    expect(sent).toHaveLength(0);
    expect(await convStatus()).toBe('canceled');
    const [c] = await sql`SELECT active, paused_reason FROM mag.warmup_chips WHERE account_id = ${b}`;
    expect(c).toMatchObject({ active: false, paused_reason: 'restrito' });
  });

  it('falha de envio encerra a conversa como cancelada', async () => {
    await tick(deps());
    sendFail = true;
    expect(await runJob(deps(), jobs.shift()!.job)).toBe('ended');
    expect(await convStatus()).toBe('canceled');
    const [m] = await sql`SELECT status FROM mag.warmup_messages`;
    expect(m!.status).toBe('failed');
  });

  it('roteiro só com links não inicia e adia o par', async () => {
    llm = fakeLlm(['A: veja www.x.com\nB: https://x.io\nA: alguem@example.com']);
    expect(await tick(deps())).toEqual({ started: 0, canceled: 0 });
    expect(jobs).toHaveLength(0);
    expect(await activeConversationOf(db, pairId)).toBeNull();
    expect((await nextAt())!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('dois ticks simultâneos no mesmo par: uma chamada de IA só', async () => {
    llm = fakeLlm([SCRIPT]);
    const [r1, r2] = await Promise.all([tick(deps()), tick(deps())]);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(r1.started + r2.started).toBe(1);
  });

  it('chip sem permissão de envio é pausado com o motivo em português', async () => {
    state = (id) => (id === b ? 'sem-permissao' : 'ok');
    await tick(deps());
    state = () => 'ok';
    const [c] = await sql`SELECT active, paused_reason FROM mag.warmup_chips WHERE account_id = ${b}`;
    expect(c).toMatchObject({ active: false, paused_reason: 'papel da conta não permite envio' });
  });

  it('desligado: nada', async () => {
    await sql`UPDATE mag.warmup_settings SET enabled = false`;
    expect(await tick(deps())).toEqual({ started: 0, canceled: 0 });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  describe('modo ai', () => {
    beforeEach(async () => {
      await sql`UPDATE mag.warmup_settings SET mode = 'ai'`;
      llm = fakeLlm(['Oi, tudo bem?', 'Tudo ótimo! E aí?', 'Também!']);
    });

    it('abertura, resposta do outro chip e fim', async () => {
      expect(await tick(deps())).toEqual({ started: 1, canceled: 0 });
      expect(llm.chat).toHaveBeenCalledTimes(1);
      expect(jobs[0]!.job).toMatchObject({ kind: 'reply', speaker: a, turn: 0 });
      expect(await runJob(deps(), jobs.shift()!.job)).toBe('sent');
      expect(sent[0]).toEqual({ from: a, to: b, text: 'Oi, tudo bem?' });

      // b recebe
      await onIncoming(deps(), { accountId: b, peerId: a, pairId, fromMe: false, text: 'Oi, tudo bem?' });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.job).toMatchObject({ kind: 'reply', speaker: b, turn: 1 });
      expect(jobs[0]!.delay).toBeGreaterThanOrEqual(15);
      expect(await runJob(deps(), jobs.shift()!.job)).toBe('sent');
      expect(sent[1]).toEqual({ from: b, to: a, text: 'Tudo ótimo! E aí?' });
      // a última chamada termina em fala do outro
      const input = llm.chat.mock.calls[1]![0];
      expect(input.messages.at(-1)).toMatchObject({ role: 'user', content: 'Oi, tudo bem?' });
    });

    it('onIncoming ignora fromMe e par sem conversa', async () => {
      await onIncoming(deps(), { accountId: b, peerId: a, pairId, fromMe: false, text: 'oi' });
      await tick(deps());
      await runJob(deps(), jobs.shift()!.job);
      await onIncoming(deps(), { accountId: b, peerId: a, pairId, fromMe: true, text: 'oi' });
      await onIncoming(deps(), { accountId: a, peerId: b, pairId, fromMe: false, text: 'oi' }); // quem falou por último foi a
      expect(jobs).toHaveLength(0);
    });

    it('abertura vazia: todos os modelos falham (log por modelo) e pausa; barrada: registra o motivo', async () => {
      const logs: string[] = [];
      const d = { ...deps(), log: (m: string) => void logs.push(m) };
      llm = fakeLlm(['']);
      await tick(d);
      expect(logs[0]).toMatch(/^maturador: modelo .+ falhou — texto vazio$/);
      expect((await getSettings(db)).pauseReason).toBe('nenhum');
      logs.length = 0;
      await sql`UPDATE mag.warmup_settings SET paused_until = NULL, pause_reason = NULL`;
      await sql`UPDATE mag.warmup_pairs SET next_at = NULL`;
      llm = fakeLlm(['veja www.x.com']);
      await tick(d);
      expect(logs).toEqual(['maturador: abertura da IA descartada — barrada pelo filtro (link): "veja www.x.com"']);
      expect(sent).toHaveLength(0);
    });

    it('resposta com número encerra sem enviar', async () => {
      llm = fakeLlm(['Oi!', 'liga 11 98765-4321']);
      await tick(deps());
      await runJob(deps(), jobs.shift()!.job);
      await onIncoming(deps(), { accountId: b, peerId: a, pairId, fromMe: false, text: 'Oi!' });
      expect(await runJob(deps(), jobs.shift()!.job)).toBe('ended');
      expect(sent).toHaveLength(1);
      expect(await convStatus()).toBe('done');
    });
  });

  it('conversa parada há mais de 60 min é cancelada', async () => {
    await tick(deps());
    jobs.length = 0;
    now = new Date(now.getTime() + 61 * 60_000);
    await sql`UPDATE mag.warmup_conversations SET last_at = ${new Date(now.getTime() - 61 * 60_000).toISOString()}::timestamptz`;
    const r = await tick({ ...deps(), now: () => now });
    expect(r.canceled).toBe(1);
    expect(await convStatus()).toBe('canceled');
  });

  it('job duplicado simultâneo envia uma vez só', async () => {
    await tick(deps());
    const job = jobs.shift()!.job;
    const r = await Promise.all([runJob(deps(), job), runJob(deps(), job)]);
    expect(r.sort()).toEqual(['sent', 'skipped']);
    expect(sent).toHaveLength(1);
  });

  it('pauseAll entre a IA e o envio: nada enviado e segue cancelada', async () => {
    await sql`UPDATE mag.warmup_settings SET mode = 'ai'`;
    llm = fakeLlm(['Oi!', 'Tudo bem?']);
    await tick(deps());
    await runJob(deps(), jobs.shift()!.job);
    await onIncoming(deps(), { accountId: b, peerId: a, pairId, fromMe: false, text: 'Oi!' });
    const job = jobs.shift()!.job;
    const chat = llm.client.chat;
    llm.client.chat = async (i) => {
      const r = await chat(i);
      await pauseAll(db);
      return r;
    };
    await runJob(deps(), job);
    expect(sent).toHaveLength(1);
    expect(await convStatus()).toBe('canceled');
  });

  it('ai: ao chegar em turnsTarget encerra done', async () => {
    await sql`UPDATE mag.warmup_settings SET mode = 'ai', turns_min = 2, turns_max = 2`;
    llm = fakeLlm(['Oi!', 'Tudo bem?']);
    await tick(deps());
    await runJob(deps(), jobs.shift()!.job);
    await onIncoming(deps(), { accountId: b, peerId: a, pairId, fromMe: false, text: 'Oi!' });
    expect(await runJob(deps(), jobs.shift()!.job)).toBe('sent');
    expect(await convStatus()).toBe('done');
    expect(await nextAt()).not.toBeNull();
  });

  it('tick com chip fora do ar não começa, não chama a IA e não pausa', async () => {
    state = () => 'desconectado';
    expect((await tick(deps())).started).toBe(0);
    expect(llm.chat).not.toHaveBeenCalled();
    const rows = await sql`SELECT active FROM mag.warmup_chips`;
    expect(rows.every((r) => r.active === true)).toBe(true);
  });

  describe('religar sozinho', () => {
    const pause = async (id: string, reason: string, minAgo: number | null) =>
      sql`UPDATE mag.warmup_chips SET active = false, paused_reason = ${reason},
        paused_at = ${minAgo === null ? null : new Date(now.getTime() - minAgo * 60_000).toISOString()}::timestamptz
        WHERE account_id = ${id}`;
    const active = async (id: string) =>
      (await sql`SELECT active, paused_reason FROM mag.warmup_chips WHERE account_id = ${id}`)[0];

    it('pausado por queda há 5 min e conectado: religa, limpa o motivo e registra', async () => {
      const logs: string[] = [];
      await pause(b, 'desconectado', 5);
      await tick({ ...deps(), log: (m: string) => void logs.push(m) });
      expect(await active(b)).toMatchObject({ active: true, paused_reason: null });
      expect(logs).toContain(`maturador: chip ${b} religado sozinho`);
    });

    it('menos de 5 min: espera; ainda fora do ar: espera e religa quando volta', async () => {
      await pause(b, 'desconectado', 4);
      await tick(deps());
      expect((await active(b))!.active).toBe(false);
      now = new Date(now.getTime() + 2 * 60_000);
      state = (id) => (id === b ? 'desconectado' : 'ok');
      await tick(deps());
      expect((await active(b))!.active).toBe(false);
      state = () => 'ok';
      await tick(deps());
      expect((await active(b))!.active).toBe(true);
    });

    it('pausa antiga sem hora gravada religa; restrição e pausa manual nunca', async () => {
      await pause(a, 'desconectado', null);
      await pause(b, 'restrito', 60);
      await tick(deps());
      expect((await active(a))!.active).toBe(true);
      expect((await active(b))!.active).toBe(false);
      await pause(b, 'tirado por você', 60);
      await tick(deps());
      expect((await active(b))!.active).toBe(false);
    });

    it('religa mesmo com o maturador desligado', async () => {
      await sql`UPDATE mag.warmup_settings SET enabled = false`;
      await pause(b, 'desconectado', 10);
      await tick(deps());
      expect((await active(b))!.active).toBe(true);
    });

    it('a pausa grava a hora (paused_at) e religar limpa', async () => {
      state = (id) => (id === b ? 'restrito' : 'ok');
      await tick(deps());
      const [p] = await sql`SELECT paused_at FROM mag.warmup_chips WHERE account_id = ${b}`;
      expect(p!.paused_at).not.toBeNull();
    });
  });

  it('tick com chip restrito pausa todos os chips restritos', async () => {
    state = () => 'restrito';
    expect((await tick(deps())).started).toBe(0);
    const rows = await sql`SELECT active, paused_reason FROM mag.warmup_chips`;
    expect(rows.every((r) => r.active === false && r.paused_reason === 'restrito')).toBe(true);
  });

  it('queda curta no meio da conversa: adia a fala e segue quando o chip volta', async () => {
    await tick(deps());
    state = (id) => (id === b ? 'desconectado' : 'ok');
    expect(await runJob(deps(), jobs.shift()!.job)).toBe('skipped');
    expect(sent).toHaveLength(0);
    expect(jobs[0]!.delay).toBe(DOWN_RETRY_SEC);
    expect(jobs[0]!.job.downSince).toBe(now.toISOString());
    now = new Date(now.getTime() + 60_000);
    state = () => 'ok';
    expect(await runJob(deps(), jobs.shift()!.job)).toBe('sent');
    expect(await convStatus()).toBe('active');
    const [c] = await sql`SELECT active FROM mag.warmup_chips WHERE account_id = ${b}`;
    expect(c!.active).toBe(true);
  });

  it('chip fora do ar por 10 min: pausa com motivo, cancela e registra no log', async () => {
    const logs: string[] = [];
    const d = { ...deps(), log: (m: string) => void logs.push(m) };
    await tick(d);
    state = (id) => (id === b ? 'desconectado' : 'ok');
    expect(await runJob(d, jobs.shift()!.job)).toBe('skipped');
    now = new Date(now.getTime() + 9 * 60_000);
    expect(await runJob(d, jobs.shift()!.job)).toBe('skipped');
    now = new Date(now.getTime() + 60_000);
    expect(await runJob(d, jobs.shift()!.job)).toBe('ended');
    expect(sent).toHaveLength(0);
    expect(await convStatus()).toBe('canceled');
    const [c] = await sql`SELECT active, paused_reason FROM mag.warmup_chips WHERE account_id = ${b}`;
    expect(c).toMatchObject({ active: false, paused_reason: 'desconectado' });
    expect(logs).toEqual([`maturador: chip ${b} pausado — desconectado há mais de 10 min`]);
  });

  it('quem começa pode ser a conta b', async () => {
    await tick({ ...deps(), rnd: () => 0.99 });
    expect(await runJob(deps(), jobs.shift()!.job)).toBe('sent');
    expect(sent[0]).toMatchObject({ from: b, to: a, text: 'oi, tudo bem?' });
  });

  describe('agendador v2', () => {
    const extra: string[] = [];
    afterEach(async () => {
      if (!extra.length) return;
      await sql`DELETE FROM mag.warmup_pairs WHERE account_a = ANY(${extra}::uuid[]) OR account_b = ANY(${extra}::uuid[])`;
      await sql`DELETE FROM mag.warmup_chips WHERE account_id = ANY(${extra}::uuid[])`;
      extra.length = 0;
    });
    let seq = 0;
    const addExtra = async (n: number) => {
      for (let i = 0; i < n; i++) {
        seq++;
        const [r] = await sql`INSERT INTO mag.wa_accounts (name, session_name, status, jid)
          VALUES (${'Extra ' + seq}, ${'extra' + seq}, 'connected', ${`55119999900${'1' + seq}@c.us`}) RETURNING id`;
        await addChip(db, String(r!.id));
        extra.push(String(r!.id));
      }
      await sql`UPDATE mag.warmup_chips SET contacts_confirmed_at = now()`;
    };
    const countConv = async () => Number((await sql`SELECT count(*) AS n FROM mag.warmup_conversations`)[0]!.n);
    const failAllFree = () => {
      for (const m of FREE_DEFAULT) bySlug[m] = 'erro';
    };
    const doneConv = async (pair: string) =>
      String((await sql`INSERT INTO mag.warmup_conversations (pair_id, mode, turns_target, lines, status, ended_at)
        VALUES (${pair}, 'queue', 20, '[]'::jsonb, 'done', now()) RETURNING id`)[0]!.id);
    const msg = (conv: string, from: string, to: string) =>
      sql`INSERT INTO mag.warmup_messages (conversation_id, from_account, to_account, body, status, created_at)
        VALUES (${conv}, ${from}, ${to}, 'x', 'sent', ${now.toISOString()}::timestamptz)`;

    it('4 chips e activeCap 3: começa 2 conversas, cada chip numa só', async () => {
      await addExtra(2);
      expect((await tick(deps())).started).toBe(2);
      const rows = await sql`SELECT p.account_a, p.account_b FROM mag.warmup_conversations c JOIN mag.warmup_pairs p ON p.id = c.pair_id`;
      expect(new Set(rows.flatMap((r) => [r.account_a, r.account_b])).size).toBe(4);
      expect((await tick(deps())).started).toBe(0);
    });

    it('meta do dia: 60 falas já enviadas bloqueiam o chip', async () => {
      const c = await doneConv(pairId);
      for (let i = 0; i < 60; i++) await msg(c, a, b);
      await sql`UPDATE mag.warmup_pairs SET next_at = NULL`;
      expect((await tick(deps())).started).toBe(0);
      expect(llm.chat).not.toHaveBeenCalled();
    });

    it('dia 1: com 2 parceiros no dia não começa com um 3º, mas repete um dos 2', async () => {
      await addExtra(2);
      const [x, y] = extra as [string, string];
      const c = await doneConv(pairId);
      await msg(c, a, x);
      await msg(c, a, y);
      await syncPairs(db);
      // só a-b (3º parceiro de a) e a-x (repetição) estão vencidos
      await sql`UPDATE mag.warmup_pairs SET next_at = now() + interval '1 day'
        WHERE NOT ((account_a = ${a} AND account_b = ${b}) OR ((account_a = ${a} OR account_b = ${a}) AND (account_a = ${x} OR account_b = ${x})))`;
      expect((await tick(deps())).started).toBe(1);
      const [p] = await sql`SELECT p.account_a, p.account_b FROM mag.warmup_conversations c JOIN mag.warmup_pairs p ON p.id = c.pair_id
        WHERE c.status = 'active'`;
      expect([p!.account_a, p!.account_b].sort()).toEqual([a, x].sort());
    });

    it('1º gratuito falha: usa o 2º e grava o modelo dele', async () => {
      bySlug[FREE_DEFAULT[0]!] = 'erro';
      await sql`UPDATE mag.warmup_settings SET model_rr = 0`;
      await tick(deps());
      const [c] = await sql`SELECT model, paid FROM mag.warmup_conversations`;
      expect(c).toMatchObject({ model: FREE_DEFAULT[1], paid: false });
    });

    it('todos os gratuitos falham, pago ok: conversa paga com custo em paidCostToday', async () => {
      failAllFree();
      llm = fakeLlm([SCRIPT], 0.002);
      expect((await tick(deps())).started).toBe(1);
      const [c] = await sql`SELECT model, paid FROM mag.warmup_conversations`;
      expect(c).toMatchObject({ model: PAID_DEFAULT[0], paid: true });
      expect(await paidCostToday(db, new Date())).toBeCloseTo(0.002, 5);
    });

    it('teto do pago estourado e gratuitos falham: pausa até 00:00 UTC, sem IA até lá, limpa depois', async () => {
      failAllFree();
      await sql`INSERT INTO mag.warmup_conversations (pair_id, mode, turns_target, lines, cost_usd, status, ended_at, paid, started_at)
        VALUES (${pairId}, 'queue', 6, '[]'::jsonb, 5, 'done', now(), true, ${now.toISOString()}::timestamptz)`;
      await sql`UPDATE mag.warmup_pairs SET next_at = NULL`;
      expect((await tick(deps())).started).toBe(0);
      const s = await getSettings(db);
      expect(s.pausedUntil).toEqual(new Date('2026-11-08T00:00:00Z'));
      expect(s.pauseReason).toBe('teto');
      expect(await countConv()).toBe(1);
      expect(llm.chat).not.toHaveBeenCalled();
      await tick(deps());
      expect(llm.chat).not.toHaveBeenCalled();
      bySlug = {};
      now = new Date('2026-11-08T00:01:00Z');
      await sql`UPDATE mag.warmup_pairs SET next_at = NULL`;
      await tick(deps());
      expect((await getSettings(db)).pausedUntil).toBeNull();
      expect(llm.chat).toHaveBeenCalled();
    });

    it('sem backup pago e gratuitos falham: pausa por cota, sem chamar pago', async () => {
      await sql`UPDATE mag.warmup_settings SET paid_backup = false`;
      failAllFree();
      await tick(deps());
      expect((await getSettings(db)).pauseReason).toBe('cota');
      expect(llm.chat).not.toHaveBeenCalled();
    });

    it('roteiro de 16 falas com turns 10 vira 10; fala em chinês é descartada com log', async () => {
      await sql`UPDATE mag.warmup_settings SET turns_min = 10, turns_max = 10`;
      const lines = Array.from({ length: 16 }, (_, i) => `${i % 2 ? 'B' : 'A'}: fala número ${i} aqui`);
      lines[2] = 'A: 你好吗';
      llm = fakeLlm([lines.join('\n')]);
      const logs: string[] = [];
      await tick({ ...deps(), log: (m: string) => void logs.push(m) });
      const [c] = await sql`SELECT jsonb_array_length(lines) AS n FROM mag.warmup_conversations`;
      expect(c!.n).toBe(10);
      expect(logs.some((l) => l.includes('fala do roteiro descartada — alfabeto'))).toBe(true);
    });

    it('tema não repete o último do par quando há 2 ou mais ativos', async () => {
      for (let i = 0; i < 5; i++) {
        await tick({ ...deps(), rnd: () => i / 5 });
        await sql`UPDATE mag.warmup_conversations SET status = 'done'`;
        await sql`UPDATE mag.warmup_pairs SET next_at = NULL`;
        now = new Date(now.getTime() + 1000);
        await sql`UPDATE mag.warmup_conversations SET started_at = started_at - (${5 - i} * interval '1 minute') WHERE true`;
      }
      const rows = await sql`SELECT theme_id FROM mag.warmup_conversations ORDER BY started_at`;
      expect(rows).toHaveLength(5);
      for (let i = 1; i < rows.length; i++) expect(rows[i]!.theme_id).not.toBe(rows[i - 1]!.theme_id);
    });

    it('o corpo enviado traz reasoning.effort: none; glm = low', async () => {
      await tick(deps());
      expect(llm.chat.mock.calls[0]![0].reasoning).toEqual({ effort: 'none' });
      await sql`UPDATE mag.warmup_conversations SET status = 'done'`;
      await sql`UPDATE mag.warmup_pairs SET next_at = NULL`;
      failAllFree();
      bySlug[PAID_DEFAULT[0]!] = 'erro';
      bySlug[PAID_DEFAULT[1]!] = 'erro';
      llm.chat.mockClear();
      await tick(deps());
      expect(llm.chat.mock.calls[0]![0].reasoning).toEqual({ effort: 'low' });
    });
  });

  describe('rodada de correções 1', () => {
    const startAi = async (texts: string[], cost = 0.001) => {
      await sql`UPDATE mag.warmup_settings SET mode = 'ai', turns_min = 6, turns_max = 6`;
      llm = fakeLlm(texts, cost);
      await tick(deps());
      expect(await runJob(deps(), jobs.shift()!.job)).toBe('sent'); // abertura (a)
      await onIncoming(deps(), { accountId: b, peerId: a, pairId, fromMe: false, text: 'Oi!' });
    };

    it('ai: resposta paga entra no teto do pago e, estourado, o pago não é mais tentado', async () => {
      now = new Date(); // started_at das conversas é o relógio real
      await sql`UPDATE mag.warmup_settings SET daily_cap_usd = 0.3`;
      await startAi(['Oi!', 'Tudo bem?', 'Também!'], 0.5);
      for (const m of FREE_DEFAULT) bySlug[m] = 'erro';
      expect(await runJob(deps(), jobs.shift()!.job)).toBe('sent');
      expect(await paidCostToday(db, new Date())).toBeGreaterThanOrEqual(0.5);
      await onIncoming(deps(), { accountId: a, peerId: b, pairId, fromMe: false, text: 'Tudo bem?' });
      const calls = llm.chat.mock.calls.length;
      expect(await runJob(deps(), jobs.shift()!.job)).toBe('ended');
      expect(llm.chat.mock.calls.length).toBe(calls);
    });

    it('ticks simultâneos com 4 chips: nunca passa do activeCap e nenhum chip em duas conversas', async () => {
      for (let i = 0; i < 2; i++) {
        const [r] = await sql`INSERT INTO mag.wa_accounts (name, session_name, status, jid)
          VALUES (${'Lock ' + i}, ${'lock' + i}, 'connected', ${`55119999900${'2' + i}@c.us`}) RETURNING id`;
        await addChip(db, String(r!.id));
      }
      await sql`UPDATE mag.warmup_chips SET contacts_confirmed_at = now()`;
      const rs = await Promise.all([tick(deps()), tick(deps()), tick(deps())]);
      expect(rs.reduce((n, r) => n + r.started, 0)).toBe(2);
      const rows = await sql`SELECT p.account_a, p.account_b FROM mag.warmup_conversations c JOIN mag.warmup_pairs p ON p.id = c.pair_id WHERE c.status = 'active'`;
      expect(new Set(rows.flatMap((r) => [r.account_a, r.account_b])).size).toBe(4);
      await sql`UPDATE mag.warmup_conversations SET status = 'canceled'`;
      await sql`DELETE FROM mag.warmup_pairs WHERE account_a IN (SELECT account_id FROM mag.warmup_chips WHERE account_id NOT IN (${a}, ${b})) OR account_b IN (SELECT account_id FROM mag.warmup_chips WHERE account_id NOT IN (${a}, ${b}))`;
      await sql`DELETE FROM mag.warmup_chips WHERE account_id NOT IN (${a}, ${b})`;
    });

    it('sem chave da OpenRouter: loga uma vez e não pausa', async () => {
      const logs: string[] = [];
      await tick({ ...deps(), llm: () => null, log: (m: string) => void logs.push(m) });
      expect(logs).toEqual(['maturador: sem chave da OpenRouter']);
      expect((await getSettings(db)).pausedUntil).toBeNull();
    });

    it('ai: com a pausa do dia vigente a resposta encerra sem chamar a IA nem logar', async () => {
      await startAi(['Oi!', 'Tudo bem?']);
      await sql`UPDATE mag.warmup_settings SET paused_until = ${new Date(now.getTime() + 3600_000).toISOString()}::timestamptz, pause_reason = 'cota'`;
      const calls = llm.chat.mock.calls.length;
      const logs: string[] = [];
      expect(await runJob({ ...deps(), log: (m: string) => void logs.push(m) }, jobs.shift()!.job)).toBe('ended');
      expect(llm.chat.mock.calls.length).toBe(calls);
      expect(logs).toEqual([]);
      expect(await convStatus()).toBe('done');
    });

    it('ai: conversa sem tema e nenhum tema ativo encerra com log', async () => {
      await startAi(['Oi!', 'Tudo bem?']);
      await sql`UPDATE mag.warmup_conversations SET theme_id = NULL`;
      await sql`UPDATE mag.warmup_themes SET active = false`;
      const logs: string[] = [];
      expect(await runJob({ ...deps(), log: (m: string) => void logs.push(m) }, jobs.shift()!.job)).toBe('ended');
      expect(logs).toEqual(['maturador: conversa sem tema e nenhum tema ativo — encerrada']);
    });
  });

  describe('rodada final: custo de resposta vazia e GLM', () => {
    const failAll = () => {
      for (const m of FREE_DEFAULT) bySlug[m] = 'erro';
    };

    it('modelos pagos devolvem texto vazio com custo: o gasto entra em paidCostToday (conversa cancelada)', async () => {
      failAll();
      llm = fakeLlm([''], 0.002);
      expect((await tick(deps())).started).toBe(0);
      expect(await paidCostToday(db, new Date())).toBeCloseTo(0.006, 5); // 3 pagos x 0,002
      const [c] = await sql`SELECT status, paid, cost_usd::float8 AS cost FROM mag.warmup_conversations`;
      expect(c).toMatchObject({ status: 'canceled', paid: true });
      expect((await getSettings(db)).pausedUntil).not.toBeNull();
    });

    it('askChain: vazio pago soma ao custo do próximo que responde', async () => {
      const empty = fakeLlm([''], 0.01);
      const ok = fakeLlm(['oi'], 0.02);
      const [p1, p2] = PAID_DEFAULT as [string, string];
      const dd = { ...deps(), llm: (slug: string) => (slug === p1 ? empty.client : ok.client) };
      const r = await askChain(dd, [{ slug: p1, paid: true }, { slug: p2, paid: true }], () => ({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 120 }));
      expect(r.ok?.cost).toBeCloseTo(0.03, 5);
    });

    it('GLM pede 600 tokens (raciocínio come o orçamento); os outros mantêm o pedido', async () => {
      const f = fakeLlm(['oi']);
      const dd = { ...deps(), llm: () => f.client };
      const input = () => ({ system: 's', messages: [{ role: 'user' as const, content: 'x' }], maxTokens: 120 });
      await askChain(dd, [{ slug: 'z-ai/glm-5.3-flash', paid: true }], input);
      await askChain(dd, [{ slug: PAID_DEFAULT[0]!, paid: true }], input);
      expect(f.chat.mock.calls.map((c) => c[0].maxTokens)).toEqual([600, 120]);
    });
  });

  it('modelChain: gira pelo slot; pagos só com backup e abaixo do teto', () => {
    const [f1, f2, f3] = FREE_DEFAULT as [string, string, string];
    const p1 = PAID_DEFAULT[0]!;
    const s = { freeModels: [f1, f2, f3], paidModels: [p1], paidBackup: true, dailyCapUsd: 1 } as never;
    expect(modelChain(s, 4, 0).map((m) => m.slug)).toEqual([f2, f3, f1, p1]);
    expect(modelChain(s, 0, 1).map((m) => m.slug)).toEqual([f1, f2, f3]);
    expect(modelChain({ ...(s as object), paidBackup: false } as never, 0, 0).map((m) => m.paid)).toEqual([false, false, false]);
    // edição manual do banco: pago na lista de gratuitos (ou o contrário) e slug fora da lista aprovada ficam de fora
    const bad = { freeModels: [f1, p1, 'x/invasor'], paidModels: [f2, p1, 'x/invasor'], paidBackup: true, dailyCapUsd: 1 } as never;
    expect(modelChain(bad, 0, 0)).toEqual([{ slug: f1, paid: false }, { slug: p1, paid: true }]);
    expect(nextResetUtc(new Date('2026-11-30T23:59:00Z'))).toEqual(new Date('2026-12-01T00:00:00Z'));
  });

  it('rodízio só entre os principais; a reserva fica depois, sempre na mesma ordem', () => {
    const s = { freeModels: FREE_DEFAULT, paidModels: [], paidBackup: false, dailyCapUsd: 1 } as never;
    const [m1, m2, m3, r1, r2, r3] = FREE_DEFAULT as [string, string, string, string, string, string];
    // 6 conversas seguidas sem falha: 2 para cada principal, nenhuma para a reserva
    expect([0, 1, 2, 3, 4, 5].map((slot) => modelChain(s, slot, 0)[0]!.slug)).toEqual([m1, m2, m3, m1, m2, m3]);
    expect(modelChain(s, 1, 0).map((m) => m.slug)).toEqual([m2, m3, m1, r1, r2, r3]);
  });

  it('tentativa que não vira conversa não avança a vez do rodízio', async () => {
    const rr = async () => Number((await sql`SELECT model_rr FROM mag.warmup_settings`)[0]!.model_rr);
    const before = await rr();
    llm = fakeLlm(['A: veja www.x.com\nB: https://x.io']); // roteiro todo barrado: não começa
    await tick(deps());
    expect(await rr()).toBe(before);
    now = new Date(now.getTime() + 60 * 60_000);
    llm = fakeLlm([SCRIPT]);
    expect((await tick(deps())).started).toBeGreaterThan(0);
    expect(await rr()).toBeGreaterThan(before);
  });

  it('pauseAll descarta job pendente', async () => {
    await tick(deps());
    await pauseAll(db);
    expect((await getSettings(db)).enabled).toBe(false);
    expect(await runJob(deps(), jobs.shift()!.job)).toBe('skipped');
    expect(sent).toHaveLength(0);
    expect(await convStatus()).toBe('canceled');
  });
});
