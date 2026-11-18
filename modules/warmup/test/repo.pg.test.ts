import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { Db } from '@mag/db';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import {
  activeConversationOf,
  addChip,
  addCost,
  addPair,
  claimPair,
  NO_JID_MSG,
  cancelAllActive,
  claimTurn,
  chipAddress,
  confirmPair,
  costToday,
  duePairs,
  endConversation,
  getSettings,
  history,
  logMessage,
  matchPair,
  pageData,
  saveSettings,
  setChipActive,
  setEnabled,
  setPairActive,
  setPairNext,
  staleConversations,
  startConversation,
  confirmChipContacts,
  listThemes,
  saveTheme,
  setThemeActive,
  syncPairs,
  chipStats,
  candidatePairs,
  activeConversations,
  paidCostToday,
  setPause,
  nextModelSlot,
} from '../src/repo';

describe.skipIf(!PG_URL)('repo do maturador', () => {
  let db: Db;
  let sql: postgres.Sql;
  let drop: () => Promise<void>;
  let acc: string[] = [];
  let outsider = '';
  const META = { themeId: null, model: 'm', paid: false };
  const lines = [{ speaker: 'A' as const, text: 'oi' }, { speaker: 'B' as const, text: 'e aí' }];

  beforeAll(async () => {
    ({ db, sql, drop } = await freshDb());
    for (const i of [1, 2, 3, 4]) {
      const [r] = await sql`INSERT INTO mag.wa_accounts (name, session_name, status, jid, lid)
        VALUES (${'Conta ' + i}, ${'sess' + i}, 'connected', ${`55119999900${'0' + i}@c.us`}, ${`10000000000000${i}@lid`}) RETURNING id`;
      acc.push(String(r!.id));
    }
    outsider = acc[3]!;
    acc = acc.slice(0, 3);
    for (const a of acc) await addChip(db, a);
  });
  afterAll(async () => {
    await drop?.();
  });

  it('configurações: ida e volta e setEnabled', async () => {
    const s = await getSettings(db);
    expect(s).toMatchObject({ enabled: false, mode: 'queue', gapMinSec: 45, windowStart: null, dailyCapUsd: 1 });
    await saveSettings(db, { ...s, theme: 'futebol', mode: 'ai', windowStart: 8, windowEnd: 20, dailyCapUsd: 2.5 });
    expect(await getSettings(db)).toMatchObject({ theme: 'futebol', mode: 'ai', windowStart: 8, windowEnd: 20, dailyCapUsd: 2.5 });
    await setEnabled(db, true);
    expect((await getSettings(db)).enabled).toBe(true);
    // salvar com enabled desatualizado (corrida com "Pausar tudo") não mexe no liga/desliga
    await saveSettings(db, { ...s, enabled: false });
    expect((await getSettings(db)).enabled).toBe(true);
  });

  it('addChip recusa conta sem número sincronizado (jid nulo)', async () => {
    const [r] = await sql`INSERT INTO mag.wa_accounts (name, session_name, status) VALUES ('Sem jid', 'sessnojid', 'connected') RETURNING id`;
    await expect(addChip(db, String(r!.id))).rejects.toThrow(NO_JID_MSG);
    const rows = await sql`SELECT 1 FROM mag.warmup_chips WHERE account_id = ${String(r!.id)}`;
    expect(rows).toHaveLength(0);
  });

  it('addPair ordena a<b, recusa conta fora do maturador e reativa', async () => {
    const id = await addPair(db, acc[1]!, acc[0]!);
    const [p] = await sql`SELECT account_a, account_b FROM mag.warmup_pairs WHERE id = ${id}`;
    const [lo, hi] = [acc[0]!, acc[1]!].sort();
    expect(p).toMatchObject({ account_a: lo, account_b: hi });
    await expect(addPair(db, acc[0]!, outsider)).rejects.toThrow();
    await setPairActive(db, id, false);
    expect(await addPair(db, acc[0]!, acc[1]!)).toBe(id);
    const [q] = await sql`SELECT active FROM mag.warmup_pairs WHERE id = ${id}`;
    expect(q!.active).toBe(true);
  });

  it('duePairs, startConversation único e cancelamento ao desligar o chip', async () => {
    const [a, b] = [acc[0]!, acc[2]!];
    const id = await addPair(db, a, b);
    const now = new Date();
    expect((await duePairs(db, now)).map((p) => p.id)).not.toContain(id); // não confirmado
    await confirmPair(db, id);
    expect((await duePairs(db, now)).map((p) => p.id)).toContain(id);

    const c1 = await startConversation(db, id, 'queue', 6, lines, 0, META);
    expect(c1).toMatchObject({ pairId: id, status: 'active', turnsTarget: 6, turnsDone: 0, lastSpeaker: null, lines });
    expect(await startConversation(db, id, 'queue', 6, lines, 0, META)).toBeNull();
    expect((await duePairs(db, now)).map((p) => p.id)).not.toContain(id); // conversa ativa
    expect((await activeConversationOf(db, id))?.id).toBe(c1!.id);

    await claimTurn(db, c1!.id, a, 0);
    expect(await staleConversations(db, new Date(Date.now() + 60_000))).toContain(c1!.id);
    expect(await staleConversations(db, new Date(Date.now() - 60_000))).not.toContain(c1!.id);

    const future = new Date(Date.now() + 3_600_000);
    await endConversation(db, c1!.id, 'done', future);
    expect((await duePairs(db, now)).map((p) => p.id)).not.toContain(id); // next_at futuro
    expect((await duePairs(db, new Date(future.getTime() + 1000))).map((p) => p.id)).toContain(id);

    const c2 = await startConversation(db, id, 'queue', 6, lines, 0, META);
    expect(c2).not.toBeNull();
    await setChipActive(db, a, false, 'caiu');
    expect((await activeConversationOf(db, id))).toBeNull();
    const [row] = await sql`SELECT status FROM mag.warmup_conversations WHERE id = ${c2!.id}`;
    expect(row!.status).toBe('canceled');
    expect((await duePairs(db, new Date(future.getTime() + 1000))).map((p) => p.id)).not.toContain(id); // chip inativo
    const [chip] = await sql`SELECT active, paused_reason FROM mag.warmup_chips WHERE account_id = ${a}`;
    expect(chip).toMatchObject({ active: false, paused_reason: 'caiu' });
    await addChip(db, a); // religa
    const [chip2] = await sql`SELECT active, paused_reason FROM mag.warmup_chips WHERE account_id = ${a}`;
    expect(chip2).toMatchObject({ active: true, paused_reason: null });
  });

  it('claimTurn é atômico e endConversation respeita o status', async () => {
    const id = await addPair(db, acc[1]!, acc[2]!);
    await confirmPair(db, id);
    const c = await startConversation(db, id, 'queue', 4, lines, 0, META);
    expect(c).not.toBeNull();
    expect(await claimTurn(db, c!.id, acc[1]!, 0)).toBe(true);
    expect(await claimTurn(db, c!.id, acc[1]!, 0)).toBe(false);
    await endConversation(db, c!.id, 'canceled', null);
    await endConversation(db, c!.id, 'done', new Date());
    const [r] = await sql`SELECT status, turns_done FROM mag.warmup_conversations WHERE id = ${c!.id}`;
    expect(r).toMatchObject({ status: 'canceled', turns_done: 1 });
    await cancelAllActive(db);
    await setPairNext(db, id, new Date('2030-06-01T12:00:00Z'));
    const [p] = await sql`SELECT next_at FROM mag.warmup_pairs WHERE id = ${id}`;
    expect(new Date(p!.next_at as string).getFullYear()).toBe(2030);
  });

  it('setPairActive(false) cancela a conversa ativa', async () => {
    const id = await addPair(db, acc[1]!, acc[2]!);
    await confirmPair(db, id);
    const c = await startConversation(db, id, 'ai', 4, [], 0, META);
    await setPairActive(db, id, false);
    expect(await activeConversationOf(db, id)).toBeNull();
    expect((await sql`SELECT status FROM mag.warmup_conversations WHERE id = ${c!.id}`)[0]!.status).toBe('canceled');
  });

  it('matchPair: por @c.us, @lid, altPhone, variante do 9º dígito; null fora dos pares', async () => {
    const id = await addPair(db, acc[0]!, acc[1]!); // reativa o par (a,b)
    const hit = { accountId: acc[0]!, peerId: acc[1]!, pairId: id };
    expect(await matchPair(db, { session: 'sess1', chatId: '5511999990002@c.us' })).toEqual(hit);
    expect(await matchPair(db, { session: 'sess1', chatId: '100000000000002@lid' })).toEqual(hit);
    expect(await matchPair(db, { session: 'sess1', chatId: '100000000000077@lid', altPhone: '+55 11 99999-0002' })).toEqual(hit);
    expect(await matchPair(db, { session: 'sess1', chatId: '551199990002@c.us' })).toEqual(hit); // sem o 9
    expect(await matchPair(db, { session: 'sess1', chatId: '5511999990077@c.us' })).toBeNull();
    expect(await matchPair(db, { session: 'sess1', chatId: '5511999990004@c.us' })).toBeNull(); // fora do maturador
    expect(await matchPair(db, { session: 'nao-existe', chatId: '5511999990002@c.us' })).toBeNull();
    await setPairActive(db, id, false);
    expect(await matchPair(db, { session: 'sess1', chatId: '5511999990002@c.us' })).toBeNull();
  });

  it('chipAddress, logMessage/history e custo só do dia', async () => {
    expect(await chipAddress(db, acc[0]!)).toEqual({ session: 'sess1', chatId: '5511999990001@c.us' });
    const id = await addPair(db, acc[0]!, acc[1]!);
    const [lo, hi] = [acc[0]!, acc[1]!].sort() as [string, string];
    await endConversationIfAny(id);
    const c = await startConversation(db, id, 'ai', 4, [], 0.25, META);
    for (let i = 0; i < 3; i++) await logMessage(db, { conversationId: c!.id, from: lo, to: hi, body: `m${i}`, status: 'sent', costUsd: 0.1 });
    await logMessage(db, { conversationId: c!.id, from: hi, to: lo, body: 'x', status: 'failed', error: 'boom' });
    expect((await history(db, c!.id, 2)).map((h) => h.text)).toEqual(['m1', 'm2']);
    expect((await history(db, c!.id)).map((h) => h.text)).toEqual(['m0', 'm1', 'm2']);
    await addCost(db, c!.id, 0.05);

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const before = await costToday(db, today);
    expect(before).toBeCloseTo(0.25 + 0.05, 6); // só o custo das conversas
    // conversa de ontem (Brasília) não entra em hoje
    await sql`UPDATE mag.warmup_conversations SET started_at = now() - interval '2 days' WHERE id = ${c!.id}`;
    expect(await costToday(db, today)).toBeCloseTo(before - 0.3, 6);
    expect(await costToday(db, '2000-01-01')).toBe(0);
    // fronteira: 02:30Z do dia D ainda é D-1 em Brasília (UTC-3); 03:00Z já é D
    await sql`UPDATE mag.warmup_conversations SET started_at = ${today + 'T02:30:00Z'}::timestamptz WHERE id = ${c!.id}`;
    expect(await costToday(db, today)).toBe(0);
    await sql`UPDATE mag.warmup_conversations SET started_at = ${today + 'T03:00:00Z'}::timestamptz WHERE id = ${c!.id}`;
    expect(await costToday(db, today)).toBeCloseTo(0.3, 6);
  });

  it('claimPair reserva o par uma única vez', async () => {
    const id = await addPair(db, acc[0]!, acc[2]!);
    await sql`UPDATE mag.warmup_pairs SET next_at = NULL WHERE id = ${id}`;
    const now = new Date();
    expect(await claimPair(db, id, now, 300_000)).toBe(true);
    expect(await claimPair(db, id, now, 300_000)).toBe(false);
    expect(await claimPair(db, id, new Date(now.getTime() + 301_000), 300_000)).toBe(true);
  });

  it('pageData agrega chips, pares, mensagens e contas fora', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const d = await pageData(db, today);
    expect(d.chips).toHaveLength(3);
    expect(d.chips[0]).toMatchObject({ name: 'Conta 1', active: true, days: 0 });
    expect(d.chips.reduce((n, c) => n + c.sentToday, 0)).toBe(3);
    expect(d.pairs.length).toBeGreaterThan(0);
    expect(d.messages.length).toBe(4);
    expect(d.messages[0]).toMatchObject({ text: 'x', status: 'failed' });
    expect(d.outside.map((o) => o.accountId)).toContain(outsider);
    expect(d.costToday).toBeGreaterThan(0);
  });

  async function endConversationIfAny(pairId: string) {
    const c = await activeConversationOf(db, pairId);
    if (c) await endConversation(db, c.id, 'canceled', null);
  }
});

describe.skipIf(!PG_URL)('repo do maturador v2', () => {
  let db: Db;
  let sql: postgres.Sql;
  let drop: () => Promise<void>;
  const ids: string[] = [];
  const META = { themeId: null, model: 'm', paid: false };
  const today = new Date().toLocaleDateString('sv', { timeZone: 'America/Sao_Paulo' });

  beforeAll(async () => {
    ({ db, sql, drop } = await freshDb());
    for (const i of [1, 2, 3, 4, 5]) {
      const [r] = await sql`INSERT INTO mag.wa_accounts (name, session_name, status, jid, lid)
        VALUES (${'V' + i}, ${'vsess' + i}, 'connected', ${`55119999900${'1' + i}@c.us`}, ${`10000000000001${i}@lid`}) RETURNING id`;
      ids.push(String(r!.id));
    }
    for (const a of ids.slice(0, 4)) await addChip(db, a);
  });
  afterAll(async () => {
    await drop?.();
  });

  it('syncPairs cria os 6 pares de 4 chips, é idempotente e ignora chip inativo', async () => {
    expect(await syncPairs(db)).toBe(6);
    expect(await syncPairs(db)).toBe(0);
    await addChip(db, ids[4]!);
    await setChipActive(db, ids[4]!, false, 'manual');
    expect(await syncPairs(db)).toBe(0);
    const [n] = await sql`SELECT count(*)::int AS n FROM mag.warmup_pairs`;
    expect(n!.n).toBe(6);
  });

  it('syncPairs reativa par inativo de dupla ativa', async () => {
    const [p] = await sql`SELECT id FROM mag.warmup_pairs LIMIT 1`;
    await setPairActive(db, String(p!.id), false);
    expect(await syncPairs(db)).toBe(0);
    const [q] = await sql`SELECT active FROM mag.warmup_pairs WHERE id = ${String(p!.id)}`;
    expect(q!.active).toBe(true);
  });

  it('candidatePairs exige contatos confirmados nos dois chips e chips ativos', async () => {
    const now = new Date();
    expect(await candidatePairs(db, now)).toHaveLength(0);
    await confirmChipContacts(db, ids[0]!);
    await confirmChipContacts(db, ids[1]!);
    await confirmChipContacts(db, ids[2]!);
    const c = await candidatePairs(db, now);
    expect(c).toHaveLength(3); // pares entre 0,1,2
    expect(c[0]).toMatchObject({ lastThemeId: null, lastStartedAt: null });
    await setChipActive(db, ids[2]!, false, 'restrito');
    expect(await candidatePairs(db, now)).toHaveLength(1);
    await setChipActive(db, ids[2]!, true);
    // par com conversa ativa sai da lista
    const [p] = await sql`SELECT id FROM mag.warmup_pairs WHERE account_a = ${[ids[0]!, ids[1]!].sort()[0]!} AND account_b = ${[ids[0]!, ids[1]!].sort()[1]!}`;
    const conv = await startConversation(db, String(p!.id), 'queue', 2, [], 0, META);
    expect(await activeConversations(db)).toBe(1);
    expect(await candidatePairs(db, now)).toHaveLength(2);
    // último tema/horário aparecem; sem histórico vem primeiro (NULLS FIRST)
    await endConversation(db, conv!.id, 'done', null);
    const after = await candidatePairs(db, now);
    expect(after).toHaveLength(3);
    expect(after[2]!.id).toBe(String(p!.id));
    expect(after[2]!.lastStartedAt).toBeInstanceOf(Date);
  });

  it('chipStats conta só o dia de Brasília e só chips ativos', async () => {
    const [pr] = await sql`SELECT id, account_a, account_b FROM mag.warmup_pairs WHERE account_a = ${[ids[0]!, ids[1]!].sort()[0]!} AND account_b = ${[ids[0]!, ids[1]!].sort()[1]!}`;
    const [a, b] = [String(pr!.account_a), String(pr!.account_b)];
    const conv = await startConversation(db, String(pr!.id), 'queue', 4, [], 0, META);
    await logMessage(db, { conversationId: conv!.id, from: a, to: b, body: 'oi', status: 'sent' });
    await logMessage(db, { conversationId: conv!.id, from: a, to: b, body: 'x', status: 'failed' });
    await logMessage(db, { conversationId: conv!.id, from: b, to: a, body: 'e aí', status: 'sent' });
    await sql`INSERT INTO mag.warmup_messages (conversation_id, from_account, to_account, body, status, created_at)
      VALUES (${conv!.id}, ${a}, ${b}, 'ontem', 'sent', now() - interval '3 days')`;
    const m = await chipStats(db, new Date().toLocaleDateString('sv', { timeZone: 'America/Sao_Paulo' }), new Date());
    expect(m.has(ids[4]!)).toBe(false);
    expect(m.get(a)).toMatchObject({ day: 1, sentToday: 1, partnersToday: [b], inConversation: true });
    expect(m.get(b)).toMatchObject({ sentToday: 1, partnersToday: [a], inConversation: true });
    expect(m.get(ids[3]!)).toMatchObject({ sentToday: 0, partnersToday: [], inConversation: false });
    await endConversation(db, conv!.id, 'canceled', null);
  });

  it('paidCostToday soma só conversas pagas', async () => {
    const [pr] = await sql`SELECT id FROM mag.warmup_pairs LIMIT 1`;
    const id = String(pr!.id);
    const free = await startConversation(db, id, 'ai', 2, [], 0.4, META);
    await endConversation(db, free!.id, 'done', null);
    const paid = await startConversation(db, id, 'ai', 2, [], 0.25, { themeId: null, model: 'p', paid: true });
    await endConversation(db, paid!.id, 'done', null);
    expect(await paidCostToday(db, new Date())).toBeCloseTo(0.25);
  });

  it('nextModelSlot devolve 0,1,2 em sequência', async () => {
    expect([await nextModelSlot(db), await nextModelSlot(db), await nextModelSlot(db)]).toEqual([0, 1, 2]);
  });

  it('pausa: grava e limpa', async () => {
    const until = new Date(Date.now() + 3600_000);
    await setPause(db, until, 'cota');
    expect(await getSettings(db)).toMatchObject({ pauseReason: 'cota' });
    await setPause(db, null, null);
    expect(await getSettings(db)).toMatchObject({ pausedUntil: null, pauseReason: null });
  });

  it('temas: salvar, editar, desligar e filtrar', async () => {
    const before = (await listThemes(db)).length;
    const id = await saveTheme(db, { name: 'Culinária', allowed: 'receitas' });
    expect((await listThemes(db)).length).toBe(before + 1);
    expect(await saveTheme(db, { id, name: 'Cozinha', allowed: 'pratos', avoid: 'dietas' })).toBe(id);
    expect((await listThemes(db)).find((t) => t.id === id)).toMatchObject({ name: 'Cozinha', allowed: 'pratos', avoid: 'dietas', active: true });
    await setThemeActive(db, id, false);
    expect((await listThemes(db, true)).some((t) => t.id === id)).toBe(false);
    expect((await listThemes(db)).some((t) => t.id === id)).toBe(true);
  });

  it('pageData traz temas, meta, contatos e pares prontos', async () => {
    const d = await pageData(db, today);
    expect(d.themes.length).toBeGreaterThan(0);
    expect(d.settings).toMatchObject({ pausedUntil: null, pauseReason: null });
    expect(d.settings.freeModels.length).toBeGreaterThan(0);
    expect(d.paidToday).toBeCloseTo(0.25);
    expect(d.chips[0]).toMatchObject({ contactsConfirmed: true, day: 1, goal: 60, partnerLimit: 2 });
    expect(d.pairsTotal).toBe(6);
    expect(d.pairsReady).toBe(3);
  });
});
