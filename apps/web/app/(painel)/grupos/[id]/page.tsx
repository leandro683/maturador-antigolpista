import { notFound } from 'next/navigation';
import { operacaoOuNull } from './_operacao';
import { BuscarGrupos, ChipsForm, RemoverGrupo, RenomearForm } from '../_components/acoes';
import { Section } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, TableMessage, Td, Th } from '@/components/ui/table';
import { accountsService } from '@/server/services/accounts';
import { gruposService } from '@/server/services/grupos';

export const metadata = { title: 'Operação · Maturador + Anti-golpista' };

export default async function OperacaoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const op = await operacaoOuNull(id);
  if (!op) notFound();
  const [contas, grupos] = await Promise.all([
    accountsService().then((s) => s.list()),
    gruposService().then((s) => s.gruposDaOperacao(id)),
  ]);
  const chips = contas.filter((c) => op.accountIds.includes(c.id)).map((c) => ({ id: c.id, name: c.name }));

  return (
    <div className="space-y-6">
      <Section title="Nome">
        <RenomearForm id={id} nome={op.name} />
      </Section>

      <Section title="Chips da operação" description="Os chips que vigiam os grupos desta operação.">
        <ChipsForm id={id} contas={contas.map((c) => ({ id: c.id, name: c.name }))} marcadas={op.accountIds} />
      </Section>

      <Section
        title="Grupos monitorados"
        description="Busque os grupos em que um dos chips está e marque quais esta operação vigia."
      >
        <BuscarGrupos id={id} chips={chips} />
        <div className="mt-6">
          <Table stack>
            <thead>
              <tr>
                <Th>Grupo</Th>
                <Th>Chip</Th>
                <Th numeric>Membros</Th>
                <Th numeric>Admins</Th>
                <Th className="text-right">Ações</Th>
              </tr>
            </thead>
            <tbody>
              {grupos.map((g) => (
                <tr key={g.id}>
                  <Td className="font-medium">{g.name}</Td>
                  <Td>{g.account ?? '—'}</Td>
                  <Td numeric>{g.participants}</Td>
                  <Td numeric>{g.admins}</Td>
                  <Td>
                    <div className="flex justify-end">
                      <RemoverGrupo operacaoId={id} id={g.id} nome={g.name} />
                    </div>
                  </Td>
                </tr>
              ))}
              {!grupos.length && (
                <TableMessage colSpan={5}>
                  <EmptyState
                    compact
                    className="rounded-none border-0"
                    title="Nenhum grupo monitorado."
                    description="Use “Buscar grupos do WhatsApp” acima."
                  />
                </TableMessage>
              )}
            </tbody>
          </Table>
        </div>
      </Section>
    </div>
  );
}
