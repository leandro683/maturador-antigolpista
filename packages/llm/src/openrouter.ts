import { parseJsonObject, withJsonInstruction } from './json';
import {
  LlmError,
  type ChatInput,
  type ChatMessage,
  type ChatResult,
  type ChatStreamHandlers,
  type LlmClient,
  type LlmConfig,
  type LlmDeps,
  type StopReason,
  type ToolCall,
} from './types';

/**
 * Provedor OpenRouter (`/chat/completions`, formato OpenAI). Tradução: tool_use → `tool_calls`, tool_result →
 * mensagem `role: tool`. Custo vem em `usage.cost` (`usage: {include: true}`). 1 retry em 429/5xx/rede/timeout.
 */

const BASE = 'https://openrouter.ai/api/v1';

type OaMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

function toOpenAi(m: ChatMessage): OaMessage[] {
  if (typeof m.content === 'string') return [{ role: m.role, content: m.content }];
  const text = m.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');
  if (m.role === 'assistant') {
    const calls = m.content.filter((p) => p.type === 'tool_use');
    return [
      {
        role: 'assistant',
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      },
    ];
  }
  const out: OaMessage[] = m.content
    .filter((p) => p.type === 'tool_result')
    .map((p) => ({
      role: 'tool',
      tool_call_id: p.toolUseId,
      content: p.isError ? `ERRO: ${p.content}` : p.content,
    }));
  if (text) out.push({ role: 'user', content: text });
  return out;
}

function stopOf(r: string | null | undefined): StopReason {
  if (r === 'stop') return 'end';
  if (r === 'tool_calls') return 'tool_use';
  if (r === 'length') return 'max_tokens';
  if (r === 'content_filter') return 'refusal';
  return 'other';
}

type OaResponse = {
  model?: string;
  error?: { message?: string; code?: number };
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
};

type OaChunk = {
  model?: string;
  error?: { message?: string; code?: number | string };
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: OaResponse['usage'];
};

/** Lê um corpo SSE e chama `onData` com o conteúdo de cada linha `data:` (comentários `:` ignorados). */
export async function readSse(body: ReadableStream<Uint8Array>, onData: (data: string) => void) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const line = (raw: string) => {
    const l = raw.replace(/\r$/, '');
    if (l.startsWith('data:')) onData(l.slice(5).trim());
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, k));
        buf = buf.slice(k + 1);
      }
    }
    buf += dec.decode();
    if (buf) line(buf);
  } catch (e) {
    // erro no meio (pedaço com `error`): fecha a conexão em vez de deixá-la aberta até o servidor terminar
    await reader.cancel().catch(() => {});
    throw e;
  }
}

const retryable = (status: number) => status === 429 || status >= 500;

export function createOpenRouterClient(config: LlmConfig, deps: LlmDeps = {}): LlmClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function post(body: unknown): Promise<Response> {
    try {
      return await fetchImpl(`${config.baseUrl ?? BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL ?? 'http://localhost',
          'X-Title': 'maturador-antigolpista',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (name === 'TimeoutError' || name === 'AbortError')
        throw new LlmError('timeout', 'tempo esgotado no OpenRouter');
      throw new LlmError(
        'rede',
        `falha de rede no OpenRouter: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function once(body: unknown): Promise<OaResponse> {
    const r = await post(body);
    const j = (await r.json().catch(() => ({}))) as OaResponse;
    if (!r.ok || j.error)
      throw new LlmError(
        'http',
        `OpenRouter respondeu ${r.status}: ${j.error?.message ?? r.statusText}`,
        r.status,
      );
    return j;
  }

  function bodyOf(input: ChatInput, model: string) {
    const system = input.json ? withJsonInstruction(input.system) : input.system;
    return {
      model,
      max_tokens: input.maxTokens ?? 16_000,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...input.messages.flatMap(toOpenAi),
      ],
      ...(input.tools?.length
        ? {
            tools: input.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
      ...(input.json && !input.tools?.length ? { response_format: { type: 'json_object' } } : {}),
      ...(input.reasoning ? { reasoning: { effort: input.reasoning.effort } } : {}),
      usage: { include: true },
    };
  }

  async function withRetry<T>(fn: () => Promise<T>, canRetry: () => boolean = () => true): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const again =
          e instanceof LlmError &&
          (e.code === 'timeout' || e.code === 'rede' || (e.code === 'http' && retryable(e.status ?? 0)));
        if (!again || attempt >= config.retries || !canRetry()) throw e;
        await sleep(1000 * (attempt + 1));
      }
    }
  }

  async function chat(input: ChatInput): Promise<ChatResult> {
    const model = input.model ?? config.model;
    const t0 = Date.now();
    const body = bodyOf(input, model);
    const j = await withRetry(() => once(body));
    const choice = j.choices?.[0];
    return finish(input, model, t0, {
      text: choice?.message?.content ?? '',
      calls: choice?.message?.tool_calls ?? [],
      finish: choice?.finish_reason,
      responseModel: j.model,
      usage: j.usage,
    });
  }

  /**
   * SSE (`stream: true`): linhas `data: {...}` com `choices[0].delta` (texto e pedaços de `tool_calls` por `index`),
   * comentários `: OPENROUTER PROCESSING` ignorados, `usage` (com `cost`) no último pedaço, `data: [DONE]` no fim.
   * Só repete (429/5xx/rede) se ainda não saiu texto — senão a tela veria o começo duas vezes.
   */
  async function chatStream(input: ChatInput, handlers: ChatStreamHandlers = {}): Promise<ChatResult> {
    const model = input.model ?? config.model;
    const t0 = Date.now();
    const body = { ...bodyOf(input, model), stream: true };
    let emitted = false;
    const onText = (d: string) => {
      emitted = true;
      try {
        handlers.onText?.(d);
      } catch {
        /* quem ouve caiu: o turno segue */
      }
    };
    return withRetry(
      async () => {
        const r = await post(body);
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as OaResponse;
          throw new LlmError(
            'http',
            `OpenRouter respondeu ${r.status}: ${j.error?.message ?? r.statusText}`,
            r.status,
          );
        }
        if (!r.body) throw new LlmError('rede', 'OpenRouter não devolveu o corpo do streaming');
        let text = '';
        let finishReason: string | null | undefined;
        let responseModel: string | undefined;
        let usage: OaResponse['usage'];
        const calls: { id: string; function: { name: string; arguments: string } }[] = [];
        const handle = (data: string) => {
          if (data === '[DONE]') return;
          let chunk: OaChunk;
          try {
            chunk = JSON.parse(data) as OaChunk;
          } catch {
            return;
          }
          if (chunk.error)
            throw new LlmError(
              'http',
              `OpenRouter respondeu ${chunk.error.code ?? '?'}: ${chunk.error.message ?? 'erro no streaming'}`,
              typeof chunk.error.code === 'number' ? chunk.error.code : undefined,
            );
          responseModel ??= chunk.model;
          if (chunk.usage) usage = chunk.usage;
          const c = chunk.choices?.[0];
          if (!c) return;
          if (c.finish_reason) finishReason = c.finish_reason;
          const d = c.delta;
          if (d?.content) {
            text += d.content;
            onText(d.content);
          }
          for (const tc of d?.tool_calls ?? []) {
            const k = tc.index ?? calls.length;
            const cur = (calls[k] ??= { id: '', function: { name: '', arguments: '' } });
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.function.name += tc.function.name;
            if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          }
        };
        try {
          await readSse(r.body, handle);
        } catch (e) {
          if (e instanceof LlmError) throw e;
          const name = e instanceof Error ? e.name : '';
          if (name === 'TimeoutError' || name === 'AbortError')
            throw new LlmError('timeout', 'tempo esgotado no OpenRouter');
          throw new LlmError('rede', `streaming do OpenRouter caiu: ${e instanceof Error ? e.message : String(e)}`);
        }
        return finish(input, model, t0, {
          text,
          calls: calls.filter(Boolean),
          finish: finishReason,
          responseModel,
          usage,
        });
      },
      () => !emitted,
    );
  }

  function finish(
    input: ChatInput,
    model: string,
    t0: number,
    o: {
      text: string;
      calls: { id: string; function: { name: string; arguments: string } }[];
      finish: string | null | undefined;
      responseModel: string | undefined;
      usage: OaResponse['usage'];
    },
  ): ChatResult {
    const text = o.text;
    const toolCalls: ToolCall[] = o.calls.map((c) => {
      let args: unknown = {};
      try {
        args = c.function.arguments ? JSON.parse(c.function.arguments) : {};
      } catch {
        throw new LlmError('json-invalido', `argumentos inválidos na ferramenta ${c.function.name}`);
      }
      return { id: c.id, name: c.function.name, input: args };
    });
    const stopReason = toolCalls.length ? 'tool_use' : stopOf(o.finish);
    if (stopReason === 'refusal') throw new LlmError('recusa', 'o modelo recusou o pedido');
    return {
      provider: 'openrouter',
      model: o.responseModel ?? model,
      text,
      toolCalls,
      ...(input.json && stopReason !== 'tool_use' ? { json: parseJsonObject(text) } : {}),
      stopReason,
      usage: {
        inputTokens: o.usage?.prompt_tokens ?? 0,
        outputTokens: o.usage?.completion_tokens ?? 0,
        costUsd: typeof o.usage?.cost === 'number' ? o.usage.cost : null,
      },
      ms: Date.now() - t0,
    };
  }

  return { config, chat, chatStream };
}
