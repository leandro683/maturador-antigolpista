import { createHash } from 'node:crypto';
import { verifyHmac, type HmacAlgorithm } from '@mag/shared/hmac';
import { dedupKeyOf, type WahaWebhook } from '@mag/wa-engine';

/** Job da fila `wa-events` (o worker traduz o aviso do WAHA e age). */
export type WaEventsJob = { webhook: WahaWebhook };

/** Portas do receiver de webhooks do WAHA (route: app/api/wa/events). */
export type WaIngestDeps = {
  secret?: string;
  /** só com WA_FAKE_ENGINE=1: aceita aviso sem assinatura quando não há segredo (demo/e2e) */
  allowUnsigned?: boolean;
  enqueue(job: WaEventsJob, jobId: string): Promise<void>;
};

export type IngestResult = { status: number; body: Record<string, unknown> };

/** Teto do corpo do aviso (os do WAHA têm poucos KB): a rota é pública e lê o corpo inteiro na memória antes de conferir a assinatura. */
export const MAX_WEBHOOK_BYTES = 2_000_000;

/** `true` quando o `Content-Length` falta, é inválido ou passa do teto (a rota responde 413 sem ler o corpo). */
export function webhookTooLarge(contentLength: string | null): boolean {
  if (contentLength === null || !/^\d+$/.test(contentLength.trim())) return true;
  return Number(contentLength) > MAX_WEBHOOK_BYTES;
}

/**
 * Autentica o aviso pela assinatura (HMAC), valida o envelope e enfileira. Nada é gravado no banco aqui.
 * O jobId é a chave de deduplicação (determinística): o reenvio do WAHA vira o mesmo job e o BullMQ ignora o add.
 */
export async function ingestWaEvent(
  rawBody: string,
  headers: { hmac: string | null; algorithm: string | null },
  deps: WaIngestDeps,
): Promise<IngestResult> {
  if (deps.secret) {
    const algorithm = (headers.algorithm?.toLowerCase() ?? 'sha512') as HmacAlgorithm;
    if (algorithm !== 'sha512' && algorithm !== 'sha256') return { status: 400, body: { error: 'algoritmo HMAC' } };
    if (!verifyHmac(rawBody, deps.secret, headers.hmac, algorithm)) return { status: 401, body: { error: 'hmac' } };
  } else if (!deps.allowUnsigned) {
    // segredo ausente: quem chama sem autenticação não precisa saber disso (a rota registra no log)
    return { status: 401, body: { error: 'hmac' } };
  }

  let w: WahaWebhook;
  try {
    w = JSON.parse(rawBody) as WahaWebhook;
  } catch {
    return { status: 400, body: { error: 'json' } };
  }
  if (!w || typeof w.event !== 'string' || typeof w.session !== 'string')
    return { status: 400, body: { error: 'envelope' } };

  const jobId = createHash('sha256').update(dedupKeyOf(w)).digest('hex');
  await deps.enqueue({ webhook: w }, jobId);
  return { status: 200, body: { ok: true } };
}
