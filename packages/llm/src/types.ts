/**
 * Camada de provedor de LLM: API única `chat()` sobre Anthropic (Messages API) ou OpenRouter
 * (formato OpenAI). Tipos neutros — cada provedor traduz. Ferramentas (tool use) nos dois.
 */

export type LlmProvider = 'anthropic' | 'openrouter';

export type TextPart = { type: 'text'; text: string };
export type ToolUsePart = { type: 'tool_use'; id: string; name: string; input: unknown };
export type ToolResultPart = { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };
export type ContentPart = TextPart | ToolUsePart | ToolResultPart;

export type ChatMessage = { role: 'user' | 'assistant'; content: string | ContentPart[] };

/** Ferramenta: `inputSchema` é JSON Schema (objeto). */
export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

export type ChatInput = {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** `true` = a resposta tem de ser 1 objeto JSON (instrução + parse; vem em `result.json`) */
  json?: boolean;
  maxTokens?: number;
  /** sobrescreve o modelo da config (ex.: `LLM_MODEL_EXTRACAO`) */
  model?: string;
  /** esforço de raciocínio — só a OpenRouter usa (`reasoning: { effort }`); a Anthropic ignora */
  reasoning?: { effort: 'none' | 'low' | 'medium' | 'high' };
};

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export type ToolCall = { id: string; name: string; input: unknown };

export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
  /** US$ — OpenRouter informa; Anthropic = tabela de preço (null se o modelo não estiver na tabela) */
  costUsd: number | null;
};

export type ChatResult = {
  provider: LlmProvider;
  model: string;
  text: string;
  toolCalls: ToolCall[];
  /** só com `json: true` */
  json?: unknown;
  stopReason: StopReason;
  usage: LlmUsage;
  ms: number;
};

export type LlmConfig = {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  timeoutMs: number;
  /** tentativas extras em 429/5xx/rede/timeout (padrão 1) */
  retries: number;
  baseUrl?: string;
  /** Anthropic: chave de organização (não presa a um workspace) exige o header `anthropic-workspace-id` */
  workspaceId?: string;
};

export class LlmError extends Error {
  constructor(
    readonly code: 'config' | 'http' | 'timeout' | 'json-invalido' | 'recusa' | 'rede',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Streaming: `onText` recebe cada pedaço de texto conforme chega (as chamadas de ferramenta só vêm no fim). */
export type ChatStreamHandlers = {
  onText?: (delta: string) => void;
};

export type LlmClient = {
  config: LlmConfig;
  chat(input: ChatInput): Promise<ChatResult>;
  /**
   * Igual a `chat()`, mas o texto chega aos pedaços em `onText`; o retorno final é o mesmo (texto inteiro, tool calls,
   * custo). Opcional na interface (clientes falsos antigos); os dois provedores implementam.
   */
  chatStream?(input: ChatInput, handlers?: ChatStreamHandlers): Promise<ChatResult>;
};

export type LlmDeps = {
  fetchImpl?: typeof fetch;
  /** espera entre tentativas (testes passam no-op) */
  sleep?: (ms: number) => Promise<void>;
};
