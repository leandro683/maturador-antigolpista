import type { Db } from '@mag/db';
import type { ChatInput, LlmClient } from '@mag/llm';
import { appDay } from './util';
import {
  activeConversationOf,
  activeConversations,
  candidatePairs,
  chipStats,
  listThemes,
  nextModelSlot,
  peekModelSlot,
  paidCostToday,
  setPause,
  syncPairs,
  withTickLock,
  type Theme,
  addCost,
  cancelAllActive,
  claimPair,
  claimTurn,
  chipsPausedFor,
  endConversation,
  getConversation,
  getSettings,
  history,
  logMessage,
  setChipActive,
  setEnabled,
  setPairNext,
  staleConversations,
  startConversation,
  type Conversation,
  type PairRow,
} from './repo';
import { isFree, modelInfo } from './models';
import { rampFor } from './ramp';
import { between, cleanLine, gapSec, lineProblem, inWindow, parseScript, pauseMs, replyDelaySec, replyPrompt, scriptPrompt, type ScriptLine } from './rules';
import { STALE_CONV_MIN, type WarmupSettings } from './settings';

export type WarmupJob = (
  | { kind: 'line'; conversationId: string; idx: number }
  | { kind: 'reply'; conversationId: string; speaker: string; turn: number }
) & { /** ISO: desde quando um chip da fala está fora do ar (fala adiada, não pausada) */ downSince?: string };
/** Queda curta (reconexão do WhatsApp): a fala é adiada de minuto em minuto; só pausa o chip depois disso. */
export const DOWN_GRACE_MS = 10 * 60_000;
export const DOWN_RETRY_SEC = 60;
/** Chip pausado por queda volta sozinho depois disso. */
export const AUTO_RESUME_MS = 5 * 60_000;
export type ChipState = 'ok' | 'desconectado' | 'restrito' | 'sem-permissao';
/** Motivo (PT) gravado em `paused_reason` quando o chip sai do maturador. */
const PAUSE_REASON: Record<Exclude<ChipState, 'ok'>, string> = {
  desconectado: 'desconectado',
  restrito: 'restrito',
  'sem-permissao': 'papel da conta não permite envio',
};
/** Quanto o par fica reservado enquanto a IA gera o roteiro (tick sobreposto não o pega de novo). */
const CLAIM_HOLD_MS = 5 * 60_000;
export type WarmupDeps = {
  db: Db;
  llm: (model: string) => LlmClient | null;
  send: (o: { from: string; to: string; text: string }) => Promise<void>;
  chipState: (accountId: string) => Promise<ChipState>;
  schedule: (job: WarmupJob, delaySec: number) => Promise<void>;
  now?: () => Date;
  rnd?: () => number;
  log?: (m: string, e?: unknown) => void;
};

const clock = (d: WarmupDeps) => (d.now ?? (() => new Date()))();
const rand = (d: WarmupDeps) => d.rnd ?? Math.random;
const after = (d: WarmupDeps, s: WarmupSettings) => new Date(clock(d).getTime() + pauseMs(s, rand(d)));

/** Próxima 00:00 UTC (21:00 de Brasília): quando a cota diária da OpenRouter e o teto do dia recomeçam. */
export const nextResetUtc = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

/** Gratuitos principais girados a partir de `slot`, depois a reserva; pagos no fim só com backup ligado e abaixo do teto do dia. */
export function modelChain(s: WarmupSettings, slot: number, paidSpent: number): { slug: string; paid: boolean }[] {
  // defesa contra edição manual do banco: só entra na lista o que é da faixa certa
  const fm = s.freeModels.filter(isFree);
  // o rodízio é só entre os principais; a reserva entra depois, na ordem, quando os principais falham
  const main = fm.filter((m) => modelInfo(m)?.tier === 'principal');
  const rotated = main.map((_, i) => main[(slot + i) % main.length]!);
  const free = [...rotated, ...fm.filter((m) => !main.includes(m))].map((slug) => ({ slug, paid: false }));
  const paid = s.paidBackup && paidSpent < s.dailyCapUsd ? s.paidModels.filter((m) => modelInfo(m)?.tier === 'pago').map((slug) => ({ slug, paid: true })) : [];
  return [...free, ...paid];
}

type Asked = { text: string; cost: number; slug: string; paid: boolean };

/** O GLM raciocina e come o orçamento de tokens: ele ganha o teto da roteirização também nas respostas curtas. */
const GLM = 'z-ai/glm-5.3-flash';
const GLM_MAX_TOKENS = 600;

/**
 * Tenta cada modelo da cadeia até um dar texto; falha (erro ou vazio) vai ao log. Todos falharam → `ok: null`.
 * `lost` = custo pago de tentativas que vieram vazias (cobradas pela OpenRouter, sem texto): quem chama o registra.
 */
/** Modelo recusado pela política de dados da chave (404) não é tentado de novo por um tempo. */
export const POLICY_BLOCK_MS = 6 * 3_600_000;
// shortcut: memória do processo (some no restart do worker); guardar no banco se a tela precisar mostrar
export const policyBlocked = new Map<string, number>();

export async function askChain(
  d: WarmupDeps,
  chain: { slug: string; paid: boolean }[],
  buildInput: () => ChatInput,
): Promise<{ ok: Asked | null; lost: number }> {
  let lost = 0;
  const now = clock(d).getTime();
  for (const m of chain) {
    if ((policyBlocked.get(m.slug) ?? 0) > now) continue;
    try {
      const llm = d.llm(m.slug);
      if (!llm) throw new Error('sem chave da OpenRouter');
      const input = buildInput();
      const r = await llm.chat({
        ...input,
        ...(m.slug === GLM ? { maxTokens: Math.max(input.maxTokens ?? 0, GLM_MAX_TOKENS) } : {}),
        reasoning: { effort: modelInfo(m.slug)?.effort ?? 'none' },
      });
      const cost = r.usage.costUsd ?? 0;
      if (!r.text.trim()) {
        if (m.paid) lost += cost;
        throw new Error('texto vazio');
      }
      return { ok: { text: r.text, cost: cost + lost, slug: m.slug, paid: m.paid }, lost: 0 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const policy = /data policy|guardrail/i.test(msg);
      if (policy) policyBlocked.set(m.slug, now + POLICY_BLOCK_MS);
      d.log?.(`maturador: modelo ${m.slug} falhou — ${msg}${policy ? ' (bloqueado pela privacidade da OpenRouter; nova tentativa em 6 h)' : ''}`);
    }
  }
  return { ok: null, lost };
}

const chainNow = async (d: WarmupDeps, s: WarmupSettings) =>
  modelChain(s, await peekModelSlot(d.db), await paidCostToday(d.db, clock(d)));

/** Registra por que uma fala da IA não foi usada (vazia ou barrada pelo filtro), com o começo do texto. */
function logDiscard(d: WarmupDeps, kind: 'abertura' | 'resposta' | 'roteiro', raw: string): void {
  const why = !raw.trim() ? 'texto vazio' : kind === 'roteiro' ? 'menos de 2 falas válidas' : `barrada pelo filtro (${lineProblem(raw.trim()) ?? 'vazio'})`;
  d.log?.(`maturador: ${kind} da IA descartada — ${why}: "${raw.trim().slice(0, 200)}"`);
}

/**
 * Chip pausado por queda ('desconectado') volta sozinho 5 min depois da pausa, assim que a conta estiver ok.
 * Restrição, falta de permissão e pausa manual nunca voltam sozinhas (insistir num chip restrito arrisca banimento).
 */
async function resumeDropped(d: WarmupDeps, now: Date): Promise<void> {
  for (const id of await chipsPausedFor(d.db, PAUSE_REASON.desconectado, new Date(now.getTime() - AUTO_RESUME_MS))) {
    if ((await d.chipState(id)) !== 'ok') continue;
    await setChipActive(d.db, id, true);
    d.log?.(`maturador: chip ${id} religado sozinho`);
  }
}

export async function tick(d: WarmupDeps): Promise<{ started: number; canceled: number }> {
  const out = { started: 0, canceled: 0 };
  const now = clock(d);
  await resumeDropped(d, now);
  return (await withTickLock(d.db, () => tickLocked(d, now, out))) ?? out;
}

async function tickLocked(d: WarmupDeps, now: Date, out: { started: number; canceled: number }): Promise<{ started: number; canceled: number }> {
  await syncPairs(d.db);
  const s = await getSettings(d.db);
  if (!s.enabled) return out;
  for (const id of await staleConversations(d.db, new Date(now.getTime() - STALE_CONV_MIN * 60_000))) {
    await endConversation(d.db, id, 'canceled', after(d, s));
    out.canceled++;
  }
  if (s.pausedUntil) {
    if (s.pausedUntil > now) return out;
    await setPause(d.db, null, null); // virou o dia: cota e teto recomeçaram
  }
  if (!inWindow(s, now)) return out;

  let free = s.activeCap - (await activeConversations(d.db));
  if (free <= 0) return out;
  const themes = await listThemes(d.db, true);
  if (!themes.length) {
    d.log?.('maturador: nenhum tema ativo — nada começa');
    return out;
  }
  if (!s.freeModels.concat(s.paidModels).some((m) => d.llm(m))) {
    d.log?.('maturador: sem chave da OpenRouter');
    return out;
  }
  const stats = await chipStats(d.db, appDay(now), now);

  for (const pair of await candidatePairs(d.db, now)) {
    if (free <= 0) break;
    try {
      const sa = stats.get(pair.a);
      const sb = stats.get(pair.b);
      if (!sa || !sb || sa.inConversation || sb.inConversation) continue;
      const over = (x: typeof sa, other: string) => {
        const r = rampFor(x.day);
        return x.sentToday >= r.goal || (!x.partnersToday.includes(other) && x.partnersToday.length >= r.partners);
      };
      if (over(sa, pair.b) || over(sb, pair.a)) continue;
      if (!(await claimPair(d.db, pair.id, now, CLAIM_HOLD_MS))) continue;
      const rnd = rand(d);
      const pool = themes.filter((t) => t.id !== pair.lastThemeId);
      const pick = pool.length ? pool : themes;
      const r = await startPair(d, s, pair, pick[Math.floor(rnd() * pick.length)]!);
      if (r === 'paused') break;
      if (r === 'started') {
        out.started++;
        free--;
        sa.inConversation = sb.inConversation = true;
      }
    } catch (e) {
      d.log?.('maturador: falha ao iniciar par', e);
    }
  }
  return out;
}

async function startPair(d: WarmupDeps, s: WarmupSettings, pair: PairRow, theme: Theme): Promise<'started' | 'skipped' | 'paused'> {
  const rnd = rand(d);
  const ids = [pair.a, pair.b];
  const states = [await d.chipState(pair.a), await d.chipState(pair.b)];
  let anyBad = false;
  for (const [i, st] of states.entries()) {
    if (st === 'ok') continue;
    anyBad = true;
    // fora do ar: só não começa agora (o par fica reservado e é tentado de novo); restrição pausa na hora
    if (st === 'desconectado') continue;
    d.log?.(`maturador: chip ${ids[i]} pausado — ${PAUSE_REASON[st]}`);
    await setChipActive(d.db, ids[i]!, false, PAUSE_REASON[st]);
  }
  if (anyBad) return 'skipped';
  const turns = between(s.turnsMin, s.turnsMax, rnd);
  const starterIsA = rnd() < 0.5;

  const paidSpent = await paidCostToday(d.db, clock(d));
  const chain = modelChain(s, await peekModelSlot(d.db), paidSpent);
  const { ok: r, lost } = await askChain(d, chain, () => (s.mode === 'queue' ? scriptPrompt(s, theme, turns) : replyPrompt(s, theme, [])));
  if (!r) {
    if (lost > 0) {
      // respostas pagas vazias foram cobradas: entram na conta do dia como conversa cancelada
      const c = await startConversation(d.db, pair.id, s.mode, turns, [], lost, { themeId: theme.id, model: chain.find((m) => m.paid)?.slug ?? '', paid: true });
      if (c) await endConversation(d.db, c.id, 'canceled', null);
    }
    const reason = paidSpent >= s.dailyCapUsd ? 'teto' : !s.paidBackup ? 'cota' : 'nenhum';
    d.log?.(`maturador: nenhum modelo respondeu — pausado até o próximo 00:00 UTC (${reason})`);
    await setPause(d.db, nextResetUtc(clock(d)), reason);
    return 'paused';
  }

  let lines: ScriptLine[] = [];
  if (s.mode === 'queue') {
    // 'A' do roteiro = quem começa; se for a conta b, troca as letras para 'A' = conta a do par
    lines = parseScript(r.text, turns, (text, why) => d.log?.(`maturador: fala do roteiro descartada — ${why}: "${text.slice(0, 200)}"`))
      .map((l) => (starterIsA ? l : { ...l, speaker: l.speaker === 'A' ? ('B' as const) : ('A' as const) }));
    if (lines.length < 2) {
      logDiscard(d, 'roteiro', r.text);
      lines = [];
    }
  } else {
    const text = cleanLine(r.text);
    if (text) lines = [{ speaker: starterIsA ? 'A' : 'B', text }];
    else logDiscard(d, 'abertura', r.text);
  }

  const meta = { themeId: theme.id, model: r.slug, paid: r.paid };
  if (!lines.length) {
    // sem roteiro/abertura utilizável: adia o par (o custo gasto entra na conta do dia como conversa cancelada)
    const c = r.cost > 0 ? await startConversation(d.db, pair.id, s.mode, turns, [], r.cost, meta) : null;
    if (c) await endConversation(d.db, c.id, 'canceled', after(d, s));
    else await setPairNext(d.db, pair.id, after(d, s));
    return 'skipped';
  }
  const conv = await startConversation(d.db, pair.id, s.mode, s.mode === 'queue' ? lines.length : turns, lines, r.cost, meta);
  if (!conv) return 'skipped';
  await nextModelSlot(d.db); // a vez do rodízio só anda quando a conversa começa de fato
  await d.schedule(
    s.mode === 'queue'
      ? { kind: 'line', conversationId: conv.id, idx: 0 }
      : { kind: 'reply', conversationId: conv.id, speaker: starterIsA ? pair.a : pair.b, turn: 0 },
    gapSec(s, rnd),
  );
  return 'started';
}

/** Próxima fala da IA; `null` = encerrar (nenhum modelo respondeu ou fala recusada); 'skip' = não é a vez. */
async function generateReply(d: WarmupDeps, s: WarmupSettings, conv: Conversation, from: string): Promise<string | 'skip' | null> {
  if (s.pausedUntil && s.pausedUntil > clock(d)) return null; // cota/teto do dia esgotado: encerra sem mexer na IA
  const h = await history(d.db, conv.id);
  if (!h.length || h[h.length - 1]!.from === from) return 'skip'; // nunca termina o pedido na nossa própria fala
  const themes = await listThemes(d.db);
  const theme = themes.find((t) => t.id === conv.themeId) ?? themes.find((t) => t.active);
  if (!theme) {
    d.log?.('maturador: conversa sem tema e nenhum tema ativo — encerrada');
    return null;
  }
  const { ok: r, lost } = await askChain(d, await chainNow(d, s), () => replyPrompt(s, theme, h.map((m) => ({ mine: m.from === from, text: m.text }))));
  if (!r) {
    if (lost > 0) await addCost(d.db, conv.id, lost, true);
    return null;
  }
  await addCost(d.db, conv.id, r.cost, r.paid);
  const text = cleanLine(r.text);
  if (!text) logDiscard(d, 'resposta', r.text);
  return text;
}

export async function runJob(d: WarmupDeps, job: WarmupJob): Promise<'sent' | 'skipped' | 'ended'> {
  const s = await getSettings(d.db);
  if (!s.enabled) return 'skipped';
  const conv = await getConversation(d.db, job.conversationId);
  if (!conv || conv.status !== 'active') return 'skipped';
  if ((job.kind === 'line' ? job.idx : job.turn) !== conv.turnsDone) return 'skipped';

  const end = async (status: 'done' | 'canceled') => {
    await endConversation(d.db, conv.id, status, after(d, s));
    return 'ended' as const;
  };

  let from: string;
  if (job.kind === 'line') {
    const line = conv.lines[job.idx];
    if (!line) return end('done');
    from = line.speaker === 'A' ? conv.a : conv.b;
  } else {
    if (job.speaker !== conv.a && job.speaker !== conv.b) return 'skipped';
    from = job.speaker;
  }
  const to = from === conv.a ? conv.b : conv.a;

  for (const id of [from, to]) {
    const st = await d.chipState(id);
    if (st === 'ok') continue;
    if (st === 'desconectado') {
      const since = job.downSince ? new Date(job.downSince) : clock(d);
      if (clock(d).getTime() - since.getTime() < DOWN_GRACE_MS) {
        await d.schedule({ ...job, downSince: since.toISOString() }, DOWN_RETRY_SEC);
        return 'skipped';
      }
    }
    d.log?.(`maturador: chip ${id} pausado — ${PAUSE_REASON[st]}${st === 'desconectado' ? ' há mais de 10 min' : ''}`);
    await setChipActive(d.db, id, false, PAUSE_REASON[st]);
    return end('canceled');
  }

  let text: string;
  if (job.kind === 'line') text = conv.lines[job.idx]!.text;
  else if (job.turn === 0) text = conv.lines[0]?.text ?? '';
  else {
    const gen = await generateReply(d, s, conv, from);
    if (gen === 'skip') return 'skipped';
    if (gen === null) return end('done');
    text = gen;
  }
  if (!text) return end('done');

  // reserva a vez de forma atômica; quem perder (job duplicado, pausa/cancelamento no meio) não envia
  const done = conv.turnsDone + 1;
  if (!(await claimTurn(d.db, conv.id, from, conv.turnsDone))) return 'skipped';
  try {
    await d.send({ from, to, text });
  } catch (e) {
    await logMessage(d.db, { conversationId: conv.id, from, to, body: text, status: 'failed', error: e instanceof Error ? e.message : String(e) });
    return end('canceled');
  }
  await logMessage(d.db, { conversationId: conv.id, from, to, body: text, status: 'sent' });

  if (conv.mode === 'queue') {
    const next = conv.lines[done];
    if (!next) await end('done');
    else await d.schedule({ kind: 'line', conversationId: conv.id, idx: done }, replyDelaySec(text, next.text, s, rand(d)));
  } else if (done >= conv.turnsTarget) {
    await end('done');
  }
  return 'sent';
}

export async function onIncoming(
  d: WarmupDeps,
  m: { accountId: string; peerId: string; pairId: string; fromMe: boolean; text: string },
): Promise<void> {
  if (m.fromMe) return;
  const conv = await activeConversationOf(d.db, m.pairId);
  if (!conv || conv.mode !== 'ai' || conv.lastSpeaker !== m.peerId || conv.turnsDone >= conv.turnsTarget) return;
  if (m.accountId !== conv.a && m.accountId !== conv.b) return;
  const s = await getSettings(d.db);
  await d.schedule(
    { kind: 'reply', conversationId: conv.id, speaker: m.accountId, turn: conv.turnsDone },
    replyDelaySec(m.text, 'x'.repeat(60), s, rand(d)),
  );
}

export async function pauseAll(db: Db): Promise<void> {
  await setEnabled(db, false);
  await cancelAllActive(db);
}
