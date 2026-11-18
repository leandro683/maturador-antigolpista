import { STATUS_META, type AccStatus } from '@mag/accounts';
import { Atualizar, AcoesConta, CriarConta } from './_components/acoes';
import { Badge, type Tone } from '@/components/ui/badge';
import { Alert } from '@/components/ui/form';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableMessage, Td, Th } from '@/components/ui/table';
import { serverEngine } from '@/server/engine';
import { accountsService, NO_ENGINE_MESSAGE } from '@/server/services/accounts';

export const metadata = { title: 'Contas · Maturador + Anti-golpista' };
export const dynamic = 'force-dynamic';

const TONE: Record<string, Tone> = { ok: 'ok', warn: 'warn', bad: 'bad', idle: 'off' };

/** Número legível a partir do JID (`5511999990001@c.us` → `+55 11 99990-0001`); sem JID, "—". */
function numeroDoJid(jid: string | null): string {
  const d = jid?.split('@')[0]?.replace(/\D/g, '') ?? '';
  if (!d) return '—';
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const resto = d.slice(4);
    return `+55 ${d.slice(2, 4)} ${resto.slice(0, -4)}-${resto.slice(-4)}`;
  }
  return `+${d}`;
}

export default async function ContasPage() {
  const contas = await (await accountsService()).list();

  return (
    <section>
      <PageHeader
        title="Contas"
        description="Os chips (números de WhatsApp) que o maturador aquece e o anti-golpista usa para vigiar os grupos."
        actions={<Atualizar />}
      />
      {!serverEngine() && (
        <Alert tone="warn" className="mb-4">
          {NO_ENGINE_MESSAGE}
        </Alert>
      )}
      <div className="mb-6">
        <CriarConta />
      </div>
      <Table stack>
        <thead>
          <tr>
            <Th>Nome</Th>
            <Th>Status</Th>
            <Th>Número</Th>
            <Th>Papel</Th>
            <Th className="text-right">Ações</Th>
          </tr>
        </thead>
        <tbody>
          {contas.map((c) => {
            const meta = STATUS_META[c.status as AccStatus] ?? { label: c.status, tone: 'idle' as const };
            const espia = (c.rolePolicy as { role?: string } | null)?.role === 'spy';
            return (
              <tr key={c.id}>
                <Td className="font-medium">{c.name}</Td>
                <Td>
                  <Badge tone={TONE[meta.tone] ?? 'off'} dot data-status={c.status}>
                    {meta.label}
                  </Badge>
                </Td>
                <Td className="whitespace-nowrap tabular-nums">{numeroDoJid(c.jid)}</Td>
                <Td>{espia ? <Badge tone="accent">Espiã</Badge> : <Badge>Normal</Badge>}</Td>
                <Td>
                  <AcoesConta id={c.id} nome={c.name} espia={espia} />
                </Td>
              </tr>
            );
          })}
          {!contas.length && (
            <TableMessage colSpan={5}>
              <EmptyState
                compact
                className="rounded-none border-0"
                title="Nenhuma conta ainda."
                description="Crie uma conta acima e conecte o chip lendo o QR code."
              />
            </TableMessage>
          )}
        </tbody>
      </Table>
    </section>
  );
}
