import { describe, expect, it } from 'vitest';
import { cleanLine, gapSec, lineProblem, inWindow, parseScript, pauseMs, replyDelaySec, replyPrompt, scriptPrompt, between } from '../src/rules';
import { DEFAULT_FORBIDDEN, WARMUP_DEFAULT_MODEL, type WarmupSettings } from '../src/settings';

const s: WarmupSettings = {
  enabled: true,
  mode: 'ai',
  model: WARMUP_DEFAULT_MODEL,
  theme: 'livros de ficção',
  allowed: 'cumprimentos, hobbies',
  forbidden: DEFAULT_FORBIDDEN,
  gapMinSec: 15,
  gapMaxSec: 15,
  typingCps: 5,
  pauseMinMin: 10,
  pauseMaxMin: 40,
  turnsMin: 6,
  turnsMax: 14,
  windowStart: null,
  windowEnd: null,
  dailyCapUsd: 1,
  freeModels: [],
  paidModels: [],
  paidBackup: true,
  activeCap: 3,
  pausedUntil: null,
  pauseReason: null,
};

const th = { name: 'livros de ficção', allowed: 'cumprimentos, hobbies', avoid: 'a tragédia da Chapecoense' };

describe('tempo', () => {
  it('between é inclusivo nas duas pontas', () => {
    expect(between(3, 7, () => 0)).toBe(3);
    expect(between(3, 7, () => 0.999999)).toBe(7);
  });
  it('gapSec respeita o teto e o piso', () => {
    expect(gapSec(s, () => 0.5)).toBe(15);
    expect(gapSec({ ...s, gapMinSec: 45, gapMaxSec: 180 }, () => 0.999)).toBeLessThanOrEqual(180);
    expect(gapSec({ ...s, gapMinSec: 1, gapMaxSec: 2 }, () => 0)).toBe(15);
  });
  it('replyDelaySec soma leitura, digitação e intervalo', () => {
    expect(replyDelaySec('a'.repeat(40), 'b'.repeat(50), s, () => 0)).toBe(27);
  });
  it('pauseMs em milissegundos', () => {
    expect(pauseMs({ ...s, pauseMinMin: 10, pauseMaxMin: 10 }, () => 0.3)).toBe(600_000);
  });
  it('inWindow usa hora de Brasília e atravessa a meia-noite', () => {
    const w = { ...s, windowStart: 22, windowEnd: 6 };
    expect(inWindow(w, new Date('2026-01-02T02:00:00Z'))).toBe(true); // 23h BRT
    expect(inWindow(w, new Date('2026-01-02T06:00:00Z'))).toBe(true); // 3h BRT
    expect(inWindow(w, new Date('2026-01-02T15:00:00Z'))).toBe(false); // 12h BRT
    expect(inWindow({ ...s, windowStart: 9, windowEnd: 18 }, new Date('2026-01-02T21:00:00Z'))).toBe(false); // 18h fora
    expect(inWindow(s, new Date())).toBe(true);
  });
});

describe('cleanLine', () => {
  it('recusa links, números, e-mails e vazio', () => {
    for (const t of ['veja www.x.com', 'me liga 11 98765-4321', 'alguem@example.com', '', 'https://x.io']) expect(cleanLine(t)).toBeNull();
  });
  it('recusa domínios, mas não palavras que só começam com com', () => {
    for (const t of ['site.net.br', 'x.io', 'olha meusite.com']) expect(cleanLine(t)).toBeNull();
    expect(cleanLine('tá.combinado')).toBe('tá.combinado');
  });
  it('limpa prefixo e aspas', () => {
    expect(cleanLine('B: "Gostei do livro!"')).toBe('Gostei do livro!');
    expect(cleanLine('x'.repeat(400))).toHaveLength(300);
  });
});

describe('parseScript', () => {
  it('aceita cerca, ignora lixo e falas recusadas', () => {
    const raw = '```\nA: Oi, tudo bem?\nlixo\nB: veja www.x.com\nB: Tudo ótimo!\n```';
    expect(parseScript(raw, 10)).toEqual([
      { speaker: 'A', text: 'Oi, tudo bem?' },
      { speaker: 'B', text: 'Tudo ótimo!' },
    ]);
  });
});

describe('lineProblem', () => {
  it('devolve o motivo', () => {
    expect(lineProblem('')).toBe('vazio');
    expect(lineProblem('veja site.com.br')).toBe('link');
    expect(lineProblem('alguem@example.com')).toBe('e-mail');
    expect(lineProblem('liga (11) 9.8765-4321')).toBe('telefone');
    expect(lineProblem('que porra é essa')).toBe('palavrão');
    expect(lineProblem('Cu ra çao')).toBe('palavrão');
    expect(lineProblem('好的 vamos')).toBe('alfabeto');
    expect(lineProblem('Que dia lindo 😄 em São Paulo')).toBeNull();
  });
});

describe('palavrão com acento', () => {
  it('detecta otário e desgraça', () => {
    expect(lineProblem('que otário')).toBe('palavrão');
    expect(lineProblem('que desgraça')).toBe('palavrão');
  });
});

describe('parseScript corte e descarte', () => {
  it('corta em turns falas válidas', () => {
    const raw = Array.from({ length: 16 }, (_, i) => `${i % 2 ? 'B' : 'A'}: fala ${i}`).join('\n');
    expect(parseScript(raw, 10)).toHaveLength(10);
  });
  it('chama onDrop e mantém a ordem', () => {
    const drops: [string, string][] = [];
    const out = parseScript('A: oi\nB: 好的\nA: tudo bem', 10, (t, w) => drops.push([t, w]));
    expect(drops).toEqual([['好的', 'alfabeto']]);
    expect(out.map((l) => l.text)).toEqual(['oi', 'tudo bem']);
  });
});

describe('prompts', () => {
  it('forbidden vazio usa o padrão', () => {
    const e = { ...s, forbidden: '' };
    expect(scriptPrompt(e, th, 6).system).toContain(DEFAULT_FORBIDDEN);
    expect(replyPrompt(e, th, []).system).toContain(DEFAULT_FORBIDDEN);
  });
  it('forbidden salvo não substitui a lista única', () => {
    const e = { ...s, forbidden: 'só links' };
    expect(scriptPrompt(e, th, 6).system).toContain('temas sensíveis da Meta');
    expect(replyPrompt(e, th, []).system).toContain('temas sensíveis da Meta');
    expect(scriptPrompt(e, { ...th, avoid: '' }, 6).system).not.toContain('Evitem:');
  });
  it('scriptPrompt', () => {
    const p = scriptPrompt(s, th, 8);
    expect(p.maxTokens).toBe(600);
    expect(p.system).toContain('livros de ficção');
    expect(p.system).toContain('não pode');
    expect(p.system).toContain('8');
    expect(p.system).toContain('a tragédia da Chapecoense');
    expect(p.system).toContain('evitem placares');
  });
  it('replyPrompt', () => {
    const p = replyPrompt(s, th, [{ mine: false, text: 'Oi' }, { mine: true, text: 'Olá' }]);
    expect(p.maxTokens).toBe(120);
    expect(p.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});
