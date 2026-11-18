import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signHmac } from '@mag/shared/hmac';
import { MAX_WEBHOOK_BYTES, ingestWaEvent, webhookTooLarge, type WaEventsJob } from '@/server/wa-events-ingest';

// A fila é sempre falsa neste arquivo (nenhuma conexão com o Redis, nem o compartilhado). O mock é içado para antes de
// qualquer import e a rota é importada uma única vez: antes, cada teste zerava os módulos e importava a rota de novo,
// e com a máquina carregada essa importação fria passava do tempo do teste.
const queue = vi.hoisted(() => ({ add: vi.fn(async (..._args: unknown[]) => ({})) }));
vi.mock('@/server/queues', () => ({ serverQueue: () => queue }));
const { POST } = await import('../app/api/wa/events/route');

const SECRET = 'segredo-de-teste-do-webhook';
const webhook = (id: string, event = 'message') => ({
  id,
  event,
  session: 'mag_00000001',
  payload: { id: `msg-${id}`, from: '5511999990001@c.us' },
});
const sign = (body: string, algorithm: 'sha512' | 'sha256' = 'sha512') => ({
  hmac: signHmac(body, SECRET, algorithm),
  algorithm,
});

describe('ingestWaEvent (HMAC → fila wa-events)', () => {
  const jobs: { job: WaEventsJob; jobId: string }[] = [];
  const enqueue = async (job: WaEventsJob, jobId: string) => void jobs.push({ job, jobId });
  const deps = { secret: SECRET, enqueue };
  beforeEach(() => {
    jobs.length = 0;
  });

  it('HMAC inválido → 401 e nada na fila', async () => {
    const body = JSON.stringify(webhook('a1'));
    const r = await ingestWaEvent(body, { hmac: 'deadbeef', algorithm: 'sha512' }, deps);
    expect(r.status).toBe(401);
    expect(jobs).toHaveLength(0);
  });

  it('sem cabeçalho de assinatura → 401; assinatura de outro corpo → 401', async () => {
    const body = JSON.stringify(webhook('a2'));
    expect((await ingestWaEvent(body, { hmac: null, algorithm: null }, deps)).status).toBe(401);
    const outro = sign(JSON.stringify(webhook('zzz')));
    expect((await ingestWaEvent(body, outro, deps)).status).toBe(401);
    expect(jobs).toHaveLength(0);
  });

  it('HMAC válido → 200 e 1 job com o aviso', async () => {
    const w = webhook('a3');
    const body = JSON.stringify(w);
    const r = await ingestWaEvent(body, sign(body), deps);
    expect(r.status).toBe(200);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job).toEqual({ webhook: w });
    expect(jobs[0]!.jobId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sha256 também vale (cabeçalho de algoritmo)', async () => {
    const body = JSON.stringify(webhook('a4'));
    expect((await ingestWaEvent(body, sign(body, 'sha256'), deps)).status).toBe(200);
    expect((await ingestWaEvent(body, { ...sign(body, 'sha256'), algorithm: 'md5' }, deps)).status).toBe(400);
  });

  it('aviso repetido → mesmo jobId (o BullMQ descarta o duplicado); aviso diferente → jobId diferente', async () => {
    const body = JSON.stringify(webhook('a5'));
    await ingestWaEvent(body, sign(body), deps);
    await ingestWaEvent(body, sign(body), deps);
    const outro = JSON.stringify(webhook('a6'));
    await ingestWaEvent(outro, sign(outro), deps);
    expect(jobs).toHaveLength(3);
    expect(jobs[1]!.jobId).toBe(jobs[0]!.jobId);
    expect(jobs[2]!.jobId).not.toBe(jobs[0]!.jobId);
  });

  it('corpo assinado mas inválido (JSON ou envelope) → 400', async () => {
    const ruim = '{não é json';
    expect((await ingestWaEvent(ruim, sign(ruim), deps)).status).toBe(400);
    const sem = JSON.stringify({ event: 'message' });
    expect((await ingestWaEvent(sem, sign(sem), deps)).status).toBe(400);
    expect(jobs).toHaveLength(0);
  });

  it('sem segredo configurado → 401 (sem revelar o motivo), a não ser com o motor falso (WA_FAKE_ENGINE=1)', async () => {
    const body = JSON.stringify(webhook('a7'));
    const sem = await ingestWaEvent(body, { hmac: null, algorithm: null }, { enqueue });
    expect(sem).toEqual({ status: 401, body: { error: 'hmac' } });
    expect(jobs).toHaveLength(0);
    const r = await ingestWaEvent(body, { hmac: null, algorithm: null }, { enqueue, allowUnsigned: true });
    expect(r.status).toBe(200);
    expect(jobs).toHaveLength(1);
  });
});

describe('POST /api/wa/events', () => {
  const add = queue.add;
  beforeEach(() => {
    add.mockReset();
    add.mockResolvedValue({});
    process.env.WAHA_HOOK_HMAC_KEY = SECRET;
    delete process.env.WA_FAKE_ENGINE;
  });

  const post = async (body: string, headers: Record<string, string>) => {
    return POST(
      new Request('http://localhost/api/wa/events', {
        method: 'POST',
        body,
        headers: { 'content-length': String(Buffer.byteLength(body)), ...headers },
      }),
    );
  };

  it('assinatura inválida → 401; válida → enfileira em wa-events com jobId = chave de deduplicação', async () => {
    const body = JSON.stringify(webhook('b1'));
    expect((await post(body, { 'x-webhook-hmac': 'ruim', 'x-webhook-hmac-algorithm': 'sha512' })).status).toBe(401);
    expect(add).not.toHaveBeenCalled();

    const h = { 'x-webhook-hmac': signHmac(body, SECRET, 'sha512'), 'x-webhook-hmac-algorithm': 'sha512' };
    expect((await post(body, h)).status).toBe(200);
    expect((await post(body, h)).status).toBe(200);
    expect(add).toHaveBeenCalledTimes(2);
    const [c1, c2] = add.mock.calls;
    expect(c1![0]).toBe('wa-event');
    expect((c1![2] as { jobId: string }).jobId).toBe((c2![2] as { jobId: string }).jobId);
  });

  it('corpo grande demais ou sem Content-Length → 413 sem ler o corpo nem enfileirar', async () => {
    expect(webhookTooLarge('100')).toBe(false);
    expect(webhookTooLarge(String(MAX_WEBHOOK_BYTES))).toBe(false);
    expect(webhookTooLarge(String(MAX_WEBHOOK_BYTES + 1))).toBe(true);
    expect([webhookTooLarge(null), webhookTooLarge('abc'), webhookTooLarge('-5'), webhookTooLarge('')]).toEqual([true, true, true, true]);
    const text = vi.fn(async () => '');
    const req = (len: string | null) =>
      ({ headers: { get: (n: string) => (n === 'content-length' ? len : null) }, text }) as unknown as Request;
    expect((await POST(req(String(MAX_WEBHOOK_BYTES + 1)))).status).toBe(413);
    expect((await POST(req(null))).status).toBe(413);
    expect(text).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('fila fora do ar → 503 (o WAHA tenta de novo)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    add.mockRejectedValueOnce(new Error('redis fora'));
    const body = JSON.stringify(webhook('b2'));
    const r = await post(body, { 'x-webhook-hmac': signHmac(body, SECRET, 'sha512'), 'x-webhook-hmac-algorithm': 'sha512' });
    expect(r.status).toBe(503);
  });
});
