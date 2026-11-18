import { NextResponse } from 'next/server';
import { serverQueue } from '@/server/queues';
import { ingestWaEvent, webhookTooLarge } from '@/server/wa-events-ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Receptor dos avisos do WAHA: assinatura HMAC → fila `wa-events` → 200 rápido.
 * Não usa a sessão do painel: quem autentica é a assinatura (WAHA_HOOK_HMAC_KEY).
 */
export async function POST(req: Request) {
  // corpo sem teto = memória esgotada por quem não tem assinatura: recusa antes de ler
  if (webhookTooLarge(req.headers.get('content-length'))) return NextResponse.json({ error: 'corpo grande demais' }, { status: 413 });
  if (!process.env.WAHA_HOOK_HMAC_KEY && process.env.WA_FAKE_ENGINE !== '1') console.error('[wa/events] WAHA_HOOK_HMAC_KEY não configurado: avisos recusados');
  const raw = await req.text();
  try {
    const r = await ingestWaEvent(
      raw,
      { hmac: req.headers.get('x-webhook-hmac'), algorithm: req.headers.get('x-webhook-hmac-algorithm') },
      {
        secret: process.env.WAHA_HOOK_HMAC_KEY,
        allowUnsigned: process.env.WA_FAKE_ENGINE === '1',
        // concluído fica 1 h: o jobId (chave de deduplicação) segura o reenvio/duplicata do WAHA
        enqueue: async (job, jobId) => {
          await serverQueue('wa-events').add('wa-event', job, {
            jobId,
            removeOnComplete: { age: 3600, count: 5000 },
          });
        },
      },
    );
    return NextResponse.json(r.body, { status: r.status });
  } catch (e) {
    console.error('[wa/events]', e);
    return NextResponse.json({ error: 'fila indisponível' }, { status: 503 }); // o WAHA tenta de novo
  }
}
