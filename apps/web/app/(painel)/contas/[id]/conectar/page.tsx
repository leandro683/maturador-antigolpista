import { notFound } from 'next/navigation';
import { QrPanel } from './qr-panel';
import { Alert } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/page-header';
import { accountsService } from '@/server/services/accounts';

export const metadata = { title: 'Conectar conta · Maturador + Anti-golpista' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ConectarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const svc = await accountsService();
  const conta = (await svc.list()).find((c) => c.id === id);
  if (!conta) notFound();
  // abrir a tela inicia o pareamento se a conta ainda não tem sessão ativa
  let erro: string | null = null;
  if (['noStatus', 'disconnected', 'needs_reauth'].includes(conta.status)) {
    try {
      await svc.connect(id);
    } catch {
      erro = 'Não consegui iniciar a sessão no WhatsApp. Confira se o servidor do WAHA está no ar e tente de novo.';
    }
  }
  return (
    <section>
      <PageHeader
        back={{ href: '/contas', label: 'Contas' }}
        title="Conectar número"
        description={`Leia o QR code com o WhatsApp do número da conta “${conta.name}”.`}
      />
      {erro && (
        <Alert tone="bad" className="mb-4">
          {erro}
        </Alert>
      )}
      <QrPanel id={id} />
    </section>
  );
}
