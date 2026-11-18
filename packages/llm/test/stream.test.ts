import { describe, expect, it } from 'vitest';
import { createLlm, streamOrChat, type LlmConfig } from '../src/index';

/** AST-v2: `chatStream()` nos dois provedores (fetch falso com corpo SSE em pedaços). */

type Call = { url: string; body: Record<string, unknown> };

function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    calls.push({ url, body: raw ? JSON.parse(String(raw)) : {} });
    const next = responses.shift();
    if (!next) throw new Error('sem resposta fake');
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Corpo SSE que chega em pedaços (quebra no meio das linhas de propósito). */
function sseResp(lines: string[], chunk = 17) {
  const all = new TextEncoder().encode(`${lines.join('\n')}\n`);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < all.length; i += chunk) c.enqueue(all.slice(i, i + chunk));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const chunk = (o: unknown) => `data: ${JSON.stringify(o)}`;

const orCfg: LlmConfig = {
  provider: 'openrouter',
  model: 'anthropic/claude-haiku-5.5',
  apiKey: 'or-test',
  timeoutMs: 5000,
  retries: 1,
};
const noSleep = async () => {};

describe('chatStream — OpenRouter (SSE)', () => {
  it('texto + tool_calls em pedaços; custo do último pedaço; comentários ignorados', async () => {
    const f = fakeFetch([
      sseResp([
        ': OPENROUTER PROCESSING',
        '',
        chunk({ model: 'anthropic/claude-haiku-5.5', choices: [{ delta: { content: 'Já ' } }] }),
        '',
        chunk({ choices: [{ delta: { content: 'vejo.' } }] }),
        chunk({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'c1', function: { name: 'metricas', arguments: '{"x"' } }],
              },
            },
          ],
        }),
        chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] }),
        chunk({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }),
        chunk({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 100, cost: 0.0012 } }),
        'data: [DONE]',
      ]),
    ]);
    const deltas: string[] = [];
    const r = await createLlm(orCfg, { fetchImpl: f.impl, sleep: noSleep }).chatStream!(
      { messages: [{ role: 'user', content: 'q' }] },
      { onText: (d) => deltas.push(d) },
    );
    expect(deltas).toEqual(['Já ', 'vejo.']);
    expect(r).toMatchObject({ provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', text: 'Já vejo.' });
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'metricas', input: { x: 1 } }]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 100, costUsd: 0.0012 });
    expect(f.calls[0]!.body).toMatchObject({ stream: true, usage: { include: true } });
  });

  it('429 antes do 1º texto repete; erro no meio do streaming não repete', async () => {
    const ok = fakeFetch([
      json(429, { error: { message: 'rate' } }),
      sseResp([chunk({ choices: [{ delta: { content: 'oi' }, finish_reason: 'stop' }] }), 'data: [DONE]']),
    ]);
    const r = await createLlm(orCfg, { fetchImpl: ok.impl, sleep: noSleep }).chatStream!({
      messages: [{ role: 'user', content: 'a' }],
    });
    expect(r.text).toBe('oi');
    expect(r.stopReason).toBe('end');
    expect(ok.calls).toHaveLength(2);

    const mid = fakeFetch([
      sseResp([
        chunk({ choices: [{ delta: { content: 'meio' } }] }),
        chunk({ error: { code: 502, message: 'provedor caiu' } }),
      ]),
      sseResp([chunk({ choices: [{ delta: { content: 'não devia' } }] })]),
    ]);
    await expect(
      createLlm(orCfg, { fetchImpl: mid.impl, sleep: noSleep }).chatStream!({
        messages: [{ role: 'user', content: 'a' }],
      }),
    ).rejects.toMatchObject({ code: 'http', status: 502 });
    expect(mid.calls).toHaveLength(1);
  });

  it('streamOrChat: cliente sem chatStream manda o texto inteiro de uma vez', async () => {
    const deltas: string[] = [];
    const r = await streamOrChat(
      {
        config: orCfg,
        chat: async () => ({
          provider: 'openrouter',
          model: 'm',
          text: 'tudo',
          toolCalls: [],
          stopReason: 'end',
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          ms: 1,
        }),
      },
      { messages: [{ role: 'user', content: 'a' }] },
      { onText: (d) => deltas.push(d) },
    );
    expect(r.text).toBe('tudo');
    expect(deltas).toEqual(['tudo']);
  });
});
