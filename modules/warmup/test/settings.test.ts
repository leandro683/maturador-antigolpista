import { describe, expect, it } from 'vitest';
import { FREE_DEFAULT, PAID_DEFAULT } from '../src/models';
import { DEFAULT_FORBIDDEN, WARMUP_DEFAULT_MODEL, warmupSettingsSchema } from '../src/settings';

const base = {
  enabled: false,
  mode: 'queue',
  model: WARMUP_DEFAULT_MODEL,
  theme: '',
  allowed: '',
  forbidden: DEFAULT_FORBIDDEN,
  gapMinSec: 45,
  gapMaxSec: 180,
  typingCps: 5,
  pauseMinMin: 10,
  pauseMaxMin: 40,
  turnsMin: 6,
  turnsMax: 14,
  windowStart: null,
  windowEnd: null,
  dailyCapUsd: 1,
  freeModels: FREE_DEFAULT,
  paidModels: PAID_DEFAULT,
  paidBackup: true,
  activeCap: 3,
};
const ok = (o: object) => warmupSettingsSchema.safeParse({ ...base, ...o }).success;

describe('warmupSettingsSchema', () => {
  it('rejeita gap maximo acima de 1800 s', () => {
    expect(ok({ gapMaxSec: 1800 })).toBe(true);
    expect(ok({ gapMaxSec: 1801 })).toBe(false);
  });
  it('rejeita slug repetido nas listas de modelos', () => {
    expect(ok({ freeModels: [FREE_DEFAULT[0], FREE_DEFAULT[0]] })).toBe(false);
    expect(ok({ paidModels: [PAID_DEFAULT[0], PAID_DEFAULT[0]] })).toBe(false);
    const r = warmupSettingsSchema.safeParse({ ...base, paidModels: [PAID_DEFAULT[0], PAID_DEFAULT[0]] });
    expect(!r.success && r.error.issues[0]!.message).toBe('Modelo repetido na lista.');
  });
  it('aceita os padrões', () => expect(ok({})).toBe(true));
  it('aceita janela completa', () => expect(ok({ windowStart: 8, windowEnd: 20 })).toBe(true));
  it('rejeita gap mínimo abaixo de 15 s', () => expect(ok({ gapMinSec: 10 })).toBe(false));
  it('rejeita gap máximo menor que o mínimo', () => expect(ok({ gapMaxSec: 30 })).toBe(false));
  it('rejeita pausa máxima menor que a mínima', () => expect(ok({ pauseMaxMin: 5 })).toBe(false));
  it('rejeita turnos máximo menor que o mínimo', () => expect(ok({ turnsMax: 4 })).toBe(false));
  it('rejeita janela só com início', () => expect(ok({ windowStart: 8 })).toBe(false));
  it('rejeita janela com início igual ao fim', () => expect(ok({ windowStart: 8, windowEnd: 8 })).toBe(false));
  it('rejeita teto de IA abaixo de US$ 0,01', () => expect(ok({ dailyCapUsd: 0.001 })).toBe(false));
  it('rejeita modo inválido', () => expect(ok({ mode: 'x' })).toBe(false));
});

describe('modelos', () => {
  const msg = (o: object) => warmupSettingsSchema.safeParse({ ...base, ...o }).error?.issues.map((i) => i.message).join('|') ?? '';
  it('recusa lista gratuita vazia', () => expect(msg({ freeModels: [] })).toBe('Escolha ao menos 1 modelo gratuito.'));
  it('recusa modelo fora da lista', () => expect(msg({ freeModels: ['openai/gpt-6-luna'] })).toBe('Modelo fora da lista aprovada: openai/gpt-6-luna.'));
  it('recusa pago em freeModels e gratuito em paidModels', () => {
    expect(ok({ freeModels: ['mistralai/mistral-nemo'] })).toBe(false);
    expect(ok({ paidModels: [FREE_DEFAULT[0]] })).toBe(false);
  });
  it('recusa teto de conversas fora de 1 a 10', () => {
    expect(ok({ activeCap: 0 })).toBe(false);
    expect(ok({ activeCap: 11 })).toBe(false);
  });
});

describe('mensagens em português', () => {
  const msg = (o: object) => warmupSettingsSchema.safeParse({ ...base, ...o }).error?.issues.map((i) => i.message).join('|') ?? '';
  it('intervalo mínimo baixo, vazio e NaN citam o campo', () => {
    expect(msg({ gapMinSec: 10 })).toBe('O intervalo mínimo deve ser de pelo menos 15 s.');
    expect(msg({ gapMinSec: undefined })).toBe('Informe o intervalo mínimo.');
    expect(msg({ gapMinSec: NaN })).toBe('Informe o intervalo mínimo.');
  });
  it('nenhuma mensagem fica em inglês', () => {
    const r = warmupSettingsSchema.safeParse({ ...base, gapMinSec: 1.5, typingCps: 99, turnsMin: 1, windowStart: 30, windowEnd: 'x', dailyCapUsd: 0 });
    expect(r.error?.issues.map((i) => i.message).join(' ')).not.toMatch(/Invalid|Too |expected|received/);
  });
});
