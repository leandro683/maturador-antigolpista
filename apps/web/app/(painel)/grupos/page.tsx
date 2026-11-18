import Link from 'next/link';
import { ArquivarBotao, CriarOperacao } from './_components/acoes';
import { buttonClass } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableMessage, Td, Th } from '@/components/ui/table';
import { gruposService } from '@/server/services/grupos';

export const metadata = { title: 'Operações · Maturador + Anti-golpista' };
export const dynamic = 'force-dynamic';

export default async function GruposPage({ searchParams }: { searchParams: Promise<{ arquivadas?: string }> }) {
  const arquivadas = (await searchParams).arquivadas === '1';
  const ops = await (await gruposService()).listar({ arquivadas });

  return (
    <section>
      <PageHeader
        title="Operações"
        description="Cada operação junta os chips e os grupos de WhatsApp que o anti-golpista vigia."
        actions={
          <Link href={arquivadas ? '/grupos' : '/grupos?arquivadas=1'} className={buttonClass('secondary')}>
            {arquivadas ? 'Ver ativas' : 'Ver arquivadas'}
          </Link>
        }
      />
      {!arquivadas && (
        <div className="mb-6">
          <CriarOperacao />
        </div>
      )}
      <Table stack>
        <thead>
          <tr>
            <Th>Operação</Th>
            <Th numeric>Chips</Th>
            <Th numeric>Grupos</Th>
            <Th className="text-right">Ações</Th>
          </tr>
        </thead>
        <tbody>
          {ops.map((o) => (
            <tr key={o.id}>
              <Td className="font-medium">{o.name}</Td>
              <Td numeric>{o.accountIds.length}</Td>
              <Td numeric>{o.grupos}</Td>
              <Td>
                <div className="flex flex-wrap justify-end gap-2">
                  <Link href={`/grupos/${o.id}`} className={buttonClass('secondary', 'sm')}>
                    Abrir
                  </Link>
                  <ArquivarBotao id={o.id} nome={o.name} arquivada={o.archived} />
                </div>
              </Td>
            </tr>
          ))}
          {!ops.length && (
            <TableMessage colSpan={4}>
              <EmptyState
                compact
                className="rounded-none border-0"
                title={arquivadas ? 'Nenhuma operação arquivada.' : 'Nenhuma operação ainda.'}
                description={arquivadas ? undefined : 'Crie uma operação acima e escolha os chips e os grupos dela.'}
              />
            </TableMessage>
          )}
        </tbody>
      </Table>
    </section>
  );
}
