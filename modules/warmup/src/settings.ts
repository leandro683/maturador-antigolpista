import { z } from 'zod';
import { isFree, modelInfo } from './models';

export const WARMUP_MODES = ['queue', 'ai'] as const;
export type WarmupMode = (typeof WARMUP_MODES)[number];

export const WARMUP_DEFAULT_MODEL = 'openai/gpt-6-luna';
/** Intervalo mínimo entre duas mensagens do maturador (proteção contra ritmo de robô). */
export const MIN_GAP_SEC = 15;
/** Teto do intervalo entre falas: acima disso a conversa estouraria a varredura de conversas paradas. */
export const MAX_GAP_SEC = 1800;
/** Conversa ativa sem movimento por mais que isso é encerrada. */
export const STALE_CONV_MIN = 60;
export const DEFAULT_FORBIDDEN =
  'links, vendas, preço, dinheiro, Pix, política, religião, telefones, e-mails, propaganda, palavrões e temas sensíveis da Meta (saúde, sexo, drogas, armas, apostas, crédito, aparência)';

export type WarmupSettings = {
  enabled: boolean;
  mode: WarmupMode;
  model: string;
  theme: string;
  allowed: string;
  forbidden: string;
  gapMinSec: number;
  gapMaxSec: number;
  typingCps: number;
  pauseMinMin: number;
  pauseMaxMin: number;
  turnsMin: number;
  turnsMax: number;
  windowStart: number | null;
  windowEnd: number | null;
  dailyCapUsd: number;
  freeModels: string[];
  paidModels: string[];
  paidBackup: boolean;
  activeCap: number;
  /** Somente leitura (gravados pelo motor): fora do formulário. */
  pausedUntil: Date | null;
  pauseReason: string | null;
};

/** Número inteiro com mensagens em PT que citam o campo (vazio/NaN/decimal/fora da faixa). */
const intIn = (nome: string, min?: number, max?: number, unid = '') => {
  let n = z.number({ error: `Informe ${nome}.` }).int(`${nome[0]!.toUpperCase()}${nome.slice(1)} deve ser um número inteiro.`);
  if (min !== undefined) n = n.min(min, `${nome[0]!.toUpperCase()}${nome.slice(1)} deve ser de pelo menos ${min}${unid}.`);
  if (max !== undefined) n = n.max(max, `${nome[0]!.toUpperCase()}${nome.slice(1)} deve ser de no máximo ${max}${unid}.`);
  return n;
};
const hour = z
  .number({ error: 'Informe a hora da janela de 0 a 23, ou deixe vazio.' })
  .int('A hora da janela deve ser um número inteiro de 0 a 23.')
  .min(0, 'A hora da janela deve ser de 0 a 23.')
  .max(23, 'A hora da janela deve ser de 0 a 23.')
  .nullable();

const noDup = (l: string[], ctx: z.RefinementCtx) => {
  if (new Set(l).size !== l.length) ctx.addIssue({ code: 'custom', message: 'Modelo repetido na lista.' });
};

export const warmupSettingsSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(WARMUP_MODES, { error: 'Escolha o modo de trabalho.' }),
    model: z.string().trim().min(1, 'Informe o modelo da OpenRouter.').max(120, 'O modelo deve ter no máximo 120 caracteres.'),
    theme: z.string().max(500, 'O tema deve ter no máximo 500 caracteres.'),
    allowed: z.string().max(1000, '"Pode falar" deve ter no máximo 1000 caracteres.'),
    forbidden: z.string().max(1000, '"Não pode falar" deve ter no máximo 1000 caracteres.'),
    gapMinSec: intIn('o intervalo mínimo', MIN_GAP_SEC, undefined, ' s'),
    gapMaxSec: intIn('o intervalo máximo', undefined, MAX_GAP_SEC, ' s'),
    typingCps: intIn('a velocidade de digitação', 1, 20, ' caracteres por segundo'),
    pauseMinMin: intIn('a pausa mínima entre conversas', 1, undefined, ' min'),
    pauseMaxMin: intIn('a pausa máxima entre conversas'),
    turnsMin: intIn('o mínimo de falas por conversa', 2, 40),
    turnsMax: intIn('o máximo de falas por conversa', undefined, 40),
    windowStart: hour,
    windowEnd: hour,
    dailyCapUsd: z
      .number({ error: 'Informe o teto de IA por dia em dólares.' })
      .min(0.01, 'O teto de IA por dia deve ser de pelo menos US$ 0,01.')
      .max(1000, 'O teto de IA por dia deve ser de no máximo US$ 1000.'),
    freeModels: z
      .array(z.string())
      .min(1, 'Escolha ao menos 1 modelo gratuito.')
      .superRefine((l, ctx) => {
        for (const m of l) if (!isFree(m)) ctx.addIssue({ code: 'custom', message: `Modelo fora da lista aprovada: ${m}.` });
        noDup(l, ctx);
      }),
    paidModels: z.array(z.string()).superRefine((l, ctx) => {
      for (const m of l) if (modelInfo(m)?.tier !== 'pago') ctx.addIssue({ code: 'custom', message: `Modelo fora da lista aprovada: ${m}.` });
      noDup(l, ctx);
    }),
    paidBackup: z.boolean(),
    activeCap: intIn('o máximo de conversas ao mesmo tempo', 1, 10),
  })
  .refine((s) => s.gapMaxSec >= s.gapMinSec, { path: ['gapMaxSec'], message: 'O intervalo máximo deve ser maior ou igual ao mínimo.' })
  .refine((s) => s.pauseMaxMin >= s.pauseMinMin, { path: ['pauseMaxMin'], message: 'A pausa máxima deve ser maior ou igual à mínima.' })
  .refine((s) => s.turnsMax >= s.turnsMin, { path: ['turnsMax'], message: 'O máximo de falas deve ser maior ou igual ao mínimo.' })
  .refine((s) => s.windowStart === null || s.windowStart !== s.windowEnd, {
    path: ['windowEnd'],
    message: 'Início e fim da janela não podem ser iguais.',
  })
  .refine((s) => (s.windowStart === null) === (s.windowEnd === null), {
    path: ['windowEnd'],
    message: 'Informe o início e o fim da janela, ou nenhum dos dois.',
  });
