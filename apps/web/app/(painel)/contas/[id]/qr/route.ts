import { AccountNotFoundError } from '@mag/accounts';
import { QrCycleExhaustedError } from '@mag/wa-engine';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { accountsService } from '@/server/services/accounts';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** QR da conta para a tela de conexão (consulta a cada poucos segundos). Só admin; nunca vai para cache. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSession()).user) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401, headers: NO_STORE });
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'Conta não encontrada.' }, { status: 404, headers: NO_STORE });
  try {
    const svc = await accountsService();
    // needs_reauth = o ciclo de QR esgotou (ou a sessão caiu): a tela oferece "Gerar novo ciclo"
    const conta = (await svc.list()).find((c) => c.id === id);
    if (!conta) return NextResponse.json({ error: 'Conta não encontrada.' }, { status: 404, headers: NO_STORE });
    if (conta.status === 'needs_reauth')
      return NextResponse.json({ error: 'Os QR codes expiraram.' }, { status: 410, headers: NO_STORE });
    const r = await svc.qr(id);
    if ('connected' in r) return NextResponse.json({ connected: true }, { headers: NO_STORE });
    return NextResponse.json({ connected: false, image: `data:image/png;base64,${r.png.toString('base64')}` }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof AccountNotFoundError)
      return NextResponse.json({ error: 'Conta não encontrada.' }, { status: 404, headers: NO_STORE });
    if (e instanceof QrCycleExhaustedError)
      return NextResponse.json({ error: 'Os QR codes expiraram.' }, { status: 410, headers: NO_STORE });
    console.error('[contas/qr]', e);
    return NextResponse.json({ error: 'QR ainda não disponível.' }, { status: 502, headers: NO_STORE });
  }
}
