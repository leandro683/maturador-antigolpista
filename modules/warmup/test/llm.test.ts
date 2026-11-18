import { beforeEach, describe, expect, it } from 'vitest';
import type { LlmClient } from '@mag/llm';
import { askChain, POLICY_BLOCK_MS, policyBlocked, type WarmupDeps } from '../src/engine';
import { warmupLlmFromEnv } from '../src/llm';

describe('chave da OpenRouter do maturador', () => {
  it('usa a chave própria quando existe', () => {
    const c = warmupLlmFromEnv('x:free', { OPENROUTER_API_KEY: 'geral', OPENROUTER_API_KEY_MATURADOR: 'propria' });
    expect(c?.config.apiKey).toBe('propria');
  });
  it('sem a própria (ou vazia), cai na chave geral; sem nenhuma, null', () => {
    expect(warmupLlmFromEnv('x:free', { OPENROUTER_API_KEY: 'geral' })?.config.apiKey).toBe('geral');
    expect(warmupLlmFromEnv('x:free', { OPENROUTER_API_KEY: 'geral', OPENROUTER_API_KEY_MATURADOR: ' ' })?.config.apiKey).toBe('geral');
    expect(warmupLlmFromEnv('x:free', {})).toBeNull();
  });
});

describe('modelo bloqueado pela política de dados', () => {
  beforeEach(() => policyBlocked.clear());
  const ok = { chat: async () => ({ text: 'A: oi', usage: { costUsd: 0 } }) } as unknown as LlmClient;

  it('404 de política: pula o modelo por 6 h e tenta de novo depois', async () => {
    let calls = 0;
    const blocked = {
      chat: async () => {
        calls++;
        throw new Error('OpenRouter respondeu 404: 0 endpoints ... guardrail restrictions and data policy');
      },
    } as unknown as LlmClient;
    let now = new Date('2026-11-10T12:00:00Z');
    const logs: string[] = [];
    const d = { llm: (s: string) => (s === 'a:free' ? blocked : ok), now: () => now, log: (m: string) => void logs.push(m) } as unknown as WarmupDeps;
    const chain = [
      { slug: 'a:free', paid: false },
      { slug: 'b:free', paid: false },
    ];
    const input = () => ({ messages: [] });

    expect((await askChain(d, chain, input)).ok?.slug).toBe('b:free');
    expect(logs[0]).toContain('bloqueado pela privacidade da OpenRouter');
    await askChain(d, chain, input);
    expect(calls).toBe(1); // segunda vez nem tentou
    now = new Date(now.getTime() + POLICY_BLOCK_MS + 1);
    await askChain(d, chain, input);
    expect(calls).toBe(2);
  });

  it('outros erros (429) não bloqueiam', async () => {
    let calls = 0;
    const busy = {
      chat: async () => {
        calls++;
        throw new Error('OpenRouter respondeu 429: Provider returned error');
      },
    } as unknown as LlmClient;
    const d = { llm: (s: string) => (s === 'a:free' ? busy : ok) } as unknown as WarmupDeps;
    const chain = [
      { slug: 'a:free', paid: false },
      { slug: 'b:free', paid: false },
    ];
    await askChain(d, chain, () => ({ messages: [] }));
    await askChain(d, chain, () => ({ messages: [] }));
    expect(calls).toBe(2);
  });
});
