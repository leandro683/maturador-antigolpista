import { createLlm, llmConfigFromEnv, type LlmClient } from '@mag/llm';

/** Maturador sempre pela OpenRouter (`OPENROUTER_API_KEY`), com o modelo próprio dele. Sem chave → null. */
export function warmupLlmFromEnv(model: string, env: Record<string, string | undefined> = process.env): LlmClient | null {
  try {
    // chave própria (sem o guardrail ZDR, que barra os gratuitos); sem ela, usa a chave geral
    const key = env.OPENROUTER_API_KEY_MATURADOR?.trim() || env.OPENROUTER_API_KEY;
    return createLlm(llmConfigFromEnv({ ...env, OPENROUTER_API_KEY: key, LLM_PROVIDER: 'openrouter', LLM_MODEL: model }, 'chat'));
  } catch {
    return null;
  }
}
