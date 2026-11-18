import { describe, expect, it } from 'vitest';
import { createLlm, DEFAULT_MODEL, llmConfigFromEnv, LlmError, type LlmConfig } from '../src/index';

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

/** fetch falso: devolve as respostas na ordem e grava as chamadas. */
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    calls.push({ url, init: init ?? {}, body: raw ? JSON.parse(String(raw)) : {} });
    const next = responses.shift();
    if (!next) throw new Error('sem resposta fake');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const orCfg: LlmConfig = {
  provider: 'openrouter',
  model: 'anthropic/claude-haiku-5.5',
  apiKey: 'or-test',
  timeoutMs: 5000,
  retries: 1,
};
const noSleep = async () => {};

describe('llmConfigFromEnv', () => {
  it('exige a chave do provedor; provedor desconhecido vira erro', () => {
    expect(llmConfigFromEnv({ LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k' })).toMatchObject({
      provider: 'openrouter',
      retries: 1,
    });
    expect(() => llmConfigFromEnv({ LLM_PROVIDER: 'openrouter' })).toThrow(/OPENROUTER_API_KEY ausente/);
    expect(() => llmConfigFromEnv({ LLM_PROVIDER: 'openai' })).toThrow(LlmError);
    expect(() => llmConfigFromEnv({ LLM_PROVIDER: 'anthropic', OPENROUTER_API_KEY: 'k' })).toThrow(/só openrouter/);
  });
  it('sem LLM_PROVIDER o padrão é openrouter (único provedor deste repositório)', () => {
    expect(llmConfigFromEnv({ OPENROUTER_API_KEY: 'k' })).toMatchObject({
      provider: 'openrouter',
      model: DEFAULT_MODEL,
      apiKey: 'k',
    });
    expect(llmConfigFromEnv({ LLM_PROVIDER: ' OpenRouter ', OPENROUTER_API_KEY: 'k' }).provider).toBe('openrouter');
    expect(() => llmConfigFromEnv({})).toThrow(/OPENROUTER_API_KEY ausente/);
    expect(llmConfigFromEnv({ OPENROUTER_API_KEY: 'k', LLM_TIMEOUT_MS: '5000' }).timeoutMs).toBe(5000);
    expect(llmConfigFromEnv({ OPENROUTER_API_KEY: 'k', LLM_TIMEOUT_MS: 'x' }).timeoutMs).toBe(120_000);
  });
  it('openrouter usa id próprio; LLM_MODEL_EXTRACAO só no uso extracao', () => {
    const env = {
      LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'k',
      LLM_MODEL_EXTRACAO: 'anthropic/claude-sonnet-5.5',
    };
    expect(llmConfigFromEnv(env).model).toBe('anthropic/claude-haiku-5.5');
    expect(llmConfigFromEnv(env, 'extracao').model).toBe('anthropic/claude-sonnet-5.5');
    expect(llmConfigFromEnv({ ...env, LLM_MODEL: 'google/gemini-2.5-flash' }).model).toBe(
      'google/gemini-2.5-flash',
    );
  });
});

describe('OpenRouter', () => {
  const orResp = (
    message: unknown,
    finish = 'stop',
    usage = { prompt_tokens: 900, completion_tokens: 100, cost: 0.0012 },
  ) =>
    json(200, { model: 'anthropic/claude-haiku-5.5', choices: [{ finish_reason: finish, message }], usage });

  it('JSON + custo informado + headers', async () => {
    const f = fakeFetch([orResp({ content: '{"data":"15/10/2026"}' })]);
    const r = await createLlm(orCfg, { fetchImpl: f.impl, sleep: noSleep }).chat({
      system: 'S',
      messages: [{ role: 'user', content: 'doc' }],
      json: true,
    });
    expect(r).toMatchObject({ provider: 'openrouter', json: { data: '15/10/2026' }, stopReason: 'end' });
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 100, costUsd: 0.0012 });
    const c = f.calls[0]!;
    expect(c.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(new Headers(c.init.headers).get('authorization')).toBe('Bearer or-test');
    expect(new Headers(c.init.headers).get('x-title')).toBe('maturador-antigolpista');
    expect(new Headers(c.init.headers).get('http-referer')).toBe(process.env.APP_URL ?? 'http://localhost');
    expect(c.body).toMatchObject({
      model: 'anthropic/claude-haiku-5.5',
      response_format: { type: 'json_object' },
    });
    expect((c.body.messages as { role: string }[])[0]!.role).toBe('system');
  });

  it('raciocínio: reasoning.effort vai no corpo; ausente = sem a chave', async () => {
    const f = fakeFetch([orResp({ content: 'a' }), orResp({ content: 'b' })]);
    const llm = createLlm(orCfg, { fetchImpl: f.impl, sleep: noSleep });
    const messages = [{ role: 'user' as const, content: 'oi' }];
    await llm.chat({ messages, reasoning: { effort: 'none' } });
    await llm.chat({ messages });
    expect(f.calls[0]!.body.reasoning).toEqual({ effort: 'none' });
    expect(f.calls[1]!.body).not.toHaveProperty('reasoning');
  });

  it('tool use: tool_calls ↔ tool_use e tool_result → role tool', async () => {
    const f = fakeFetch([
      orResp(
        {
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'metricas', arguments: '{"x":1}' } }],
        },
        'tool_calls',
      ),
    ]);
    const r = await createLlm(orCfg, { fetchImpl: f.impl, sleep: noSleep }).chat({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c0', name: 'buscar', input: { t: 'a' } }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c0', content: 'ok' }] },
      ],
      tools: [{ name: 'metricas', description: 'd', inputSchema: { type: 'object' } }],
    });
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'metricas', input: { x: 1 } }]);
    expect(r.stopReason).toBe('tool_use');
    const msgs = f.calls[0]!.body.messages as Record<string, unknown>[];
    expect(msgs[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'c0', function: { name: 'buscar', arguments: '{"t":"a"}' } }],
    });
    expect(msgs[2]).toEqual({ role: 'tool', tool_call_id: 'c0', content: 'ok' });
    expect(f.calls[0]!.body.tools).toEqual([
      { type: 'function', function: { name: 'metricas', description: 'd', parameters: { type: 'object' } } },
    ]);
  });

  it('1 retry em 429/rede; 400 não repete', async () => {
    const f = fakeFetch([json(429, { error: { message: 'rate' } }), orResp({ content: 'oi' })]);
    expect(
      (
        await createLlm(orCfg, { fetchImpl: f.impl, sleep: noSleep }).chat({
          messages: [{ role: 'user', content: 'a' }],
        })
      ).text,
    ).toBe('oi');
    expect(f.calls).toHaveLength(2);
    const net = fakeFetch([new TypeError('fetch failed'), new TypeError('fetch failed')]);
    await expect(
      createLlm(orCfg, { fetchImpl: net.impl, sleep: noSleep }).chat({
        messages: [{ role: 'user', content: 'a' }],
      }),
    ).rejects.toMatchObject({ code: 'rede' });
    expect(net.calls).toHaveLength(2);
    const bad = fakeFetch([json(400, { error: { message: 'modelo inválido' } })]);
    await expect(
      createLlm(orCfg, { fetchImpl: bad.impl, sleep: noSleep }).chat({
        messages: [{ role: 'user', content: 'a' }],
      }),
    ).rejects.toMatchObject({ code: 'http', status: 400 });
    expect(bad.calls).toHaveLength(1);
  });

  it('timeout vira LlmError timeout', async () => {
    const err = new Error('t');
    err.name = 'TimeoutError';
    const f = fakeFetch([err, err]);
    await expect(
      createLlm(orCfg, { fetchImpl: f.impl, sleep: noSleep }).chat({
        messages: [{ role: 'user', content: 'a' }],
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });
});
