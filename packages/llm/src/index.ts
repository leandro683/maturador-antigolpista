import { llmConfigFromEnv } from './config';
import { createOpenRouterClient } from './openrouter';
import { LlmError, type ChatInput, type ChatResult, type ChatStreamHandlers, type LlmClient, type LlmConfig, type LlmDeps } from './types';

export * from './types';
export { DEFAULT_MODEL, llmConfigFromEnv } from './config';
export { parseJsonObject } from './json';

/** Cliente do provedor configurado. Só OpenRouter neste pacote: `LLM_PROVIDER=openrouter`. */
export function createLlm(config: LlmConfig, deps: LlmDeps = {}): LlmClient {
  if (config.provider !== 'openrouter')
    throw new LlmError('config', 'Só o provedor openrouter está disponível (defina LLM_PROVIDER=openrouter)');
  return createOpenRouterClient(config, deps);
}

/** Atalho: `chat()` com a config do ambiente (`uso` escolhe `LLM_MODEL_EXTRACAO`). */
export function chat(
  input: ChatInput,
  opts: { uso?: 'chat' | 'extracao' } & LlmDeps = {},
): Promise<ChatResult> {
  return createLlm(llmConfigFromEnv(process.env, opts.uso), opts).chat(input);
}

/** Atalho do streaming: texto aos pedaços em `handlers.onText`, mesmo retorno final de `chat()`. */
export function chatStream(
  input: ChatInput,
  handlers: ChatStreamHandlers = {},
  opts: { uso?: 'chat' | 'extracao' } & LlmDeps = {},
): Promise<ChatResult> {
  return streamOrChat(createLlm(llmConfigFromEnv(process.env, opts.uso), opts), input, handlers);
}

/** `chatStream` do cliente quando houver; senão `chat()` e o texto inteiro de uma vez em `onText`. */
export async function streamOrChat(
  client: LlmClient,
  input: ChatInput,
  handlers: ChatStreamHandlers = {},
): Promise<ChatResult> {
  if (client.chatStream) return client.chatStream(input, handlers);
  const r = await client.chat(input);
  if (r.text) handlers.onText?.(r.text);
  return r;
}
