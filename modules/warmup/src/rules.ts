import type { ChatInput } from '@mag/llm';
import { DEFAULT_FORBIDDEN, MIN_GAP_SEC, type WarmupSettings } from './settings';

/** Inteiro uniforme em [min, max] (inclusivo), com rnd em [0, 1). */
export const between = (min: number, max: number, rnd: () => number): number => min + Math.floor(rnd() * (max - min + 1));

export const gapSec = (s: WarmupSettings, rnd: () => number): number =>
  Math.max(MIN_GAP_SEC, between(s.gapMinSec, s.gapMaxSec, rnd));

/** Leitura + digitação + intervalo; nunca abaixo do piso. */
export const replyDelaySec = (received: string, reply: string, s: WarmupSettings, rnd: () => number): number =>
  Math.max(MIN_GAP_SEC, Math.ceil(received.length / 20) + Math.ceil(reply.length / s.typingCps) + gapSec(s, rnd));

export const pauseMs = (s: WarmupSettings, rnd: () => number): number => between(s.pauseMinMin, s.pauseMaxMin, rnd) * 60_000;

/** Janela [início, fim) na hora de Brasília; início > fim atravessa a meia-noite. */
export function inWindow(s: WarmupSettings, now: Date): boolean {
  if (s.windowStart === null || s.windowEnd === null) return true;
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hourCycle: 'h23' }).format(now));
  return s.windowStart <= s.windowEnd ? h >= s.windowStart && h < s.windowEnd : h >= s.windowStart || h < s.windowEnd;
}

const QUOTES = /^["'“”‘’]+|["'“”‘’]+$/g;

const PROFANITY = new Set(
  'porra caralho merda puta puto foda foder fodase buceta cu viado arrombado cacete desgraca otario babaca vagabundo piranha'.split(' '),
);
const stripAccents = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '');

export type LineProblem = 'vazio' | 'link' | 'telefone' | 'e-mail' | 'palavrão' | 'alfabeto';

/** Motivo pelo qual a fala não pode ir ao ar; `null` = ok. */
export function lineProblem(text: string): LineProblem | null {
  if (!text) return 'vazio';
  if (/\S+@\S+/.test(text)) return 'e-mail';
  if (/https?:|www\.|\b[\w-]+\.(?:com|net|org|io|br|me|ly|info|app)\b/i.test(text)) return 'link';
  if (/\d(?:[\s.\-()]*\d){7,}/.test(text)) return 'telefone';
  if (stripAccents(text.toLowerCase()).split(/[^a-z]+/).some((w) => PROFANITY.has(w))) return 'palavrão';
  if (/(?=\p{L})\P{Script=Latin}/u.test(text)) return 'alfabeto';
  return null;
}

/** Limpa uma fala; `null` se vazia ou barrada por `lineProblem`. */
export function cleanLine(text: string): string | null {
  const t = text.trim().replace(/^[AB]\s*:\s*/, '').trim().replace(QUOTES, '').trim().slice(0, 300).trim();
  return lineProblem(t) ? null : t;
}

export type ScriptLine = { speaker: 'A' | 'B'; text: string };

/** Primeiras `turns` falas válidas; `onDrop` recebe cada fala descartada com o motivo. */
export function parseScript(raw: string, turns: number, onDrop?: (text: string, why: string) => void): ScriptLine[] {
  const out: ScriptLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([AB])\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const text = cleanLine(m[2]!);
    if (text) out.push({ speaker: m[1] as 'A' | 'B', text });
    else onDrop?.(m[2]!.trim(), lineProblem(m[2]!.trim()) ?? 'vazio');
    if (out.length >= turns) break;
  }
  return out;
}

export type ThemeLite = { name: string; allowed: string; avoid: string };

const persona = (s: WarmupSettings, th: ThemeLite): string =>
  `Você simula duas pessoas comuns conversando no WhatsApp em português do Brasil sobre: ${th.name}. ` +
  'Falas curtas e informais, como gente de verdade; varie o jeito de falar. ' +
  `Pode falar sobre: ${th.allowed || 'assuntos leves do cotidiano'}. ` +
  (th.avoid ? `Evitem: ${th.avoid}. ` : '') +
  `Você não pode falar sobre: ${DEFAULT_FORBIDDEN}. Nunca use links, números ou e-mails. Sem emojis em excesso. ` +
  'Falem de opinião e experiência pessoal; evitem placares, datas, números e estatísticas.';

export const scriptPrompt = (s: WarmupSettings, th: ThemeLite, turns: number): ChatInput => ({
  system: `${persona(s, th)}
Escreva a conversa com exatamente ${turns} linhas, alternando "A:" e "B:" (começa com A), uma fala por linha, sem mais nenhum texto.`,
  messages: [{ role: 'user', content: `Escreva a conversa com ${turns} falas.` }],
  maxTokens: 600,
});

export const replyPrompt = (s: WarmupSettings, th: ThemeLite, history: { mine: boolean; text: string }[]): ChatInput => ({
  system: `${persona(s, th)}
Responda só com a sua próxima fala, sem prefixo e sem aspas.`,
  messages: history.length
    ? history.map((h) => ({ role: h.mine ? ('assistant' as const) : ('user' as const), content: h.text }))
    : [{ role: 'user', content: 'Comece a conversa.' }],
  maxTokens: 120,
});
