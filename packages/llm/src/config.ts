import { LlmError, type LlmConfig } from './types';

/** Modelo padrão (id da OpenRouter). */
export const DEFAULT_MODEL = 'anthropic/claude-haiku-5.5';

export const DEFAULT_TIMEOUT_MS = 120_000;

type Env = Record<string, string | undefined>;

/**
 * Config a partir do ambiente (`.env`, nunca código): `LLM_PROVIDER` (só `openrouter`, que também é o padrão),
 * `OPENROUTER_API_KEY`, `LLM_MODEL`, `LLM_MODEL_EXTRACAO` (uso `extracao`) e `LLM_TIMEOUT_MS`.
 */
export function llmConfigFromEnv(env: Env = process.env, uso: 'chat' | 'extracao' = 'chat'): LlmConfig {
  const raw = (env.LLM_PROVIDER ?? 'openrouter').trim().toLowerCase();
  if (raw !== 'openrouter') throw new LlmError('config', `LLM_PROVIDER inválido: "${raw}" (só openrouter)`);
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new LlmError('config', 'OPENROUTER_API_KEY ausente (LLM_PROVIDER=openrouter)');
  const model =
    (uso === 'extracao' ? env.LLM_MODEL_EXTRACAO?.trim() : undefined) || env.LLM_MODEL?.trim() || DEFAULT_MODEL;
  const timeout = Number(env.LLM_TIMEOUT_MS);
  return {
    provider: 'openrouter',
    model,
    apiKey,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    retries: 1,
  };
}
