import { notFound } from 'next/navigation';
import { CollaboratorsManager, VerifyBox } from '../../../seguranca/_ui/collaborators';
import { PublicVerifyPage } from '../../../seguranca/_ui/public-page';
import { Badge } from '@/components/ui/badge';
import { Card, Section } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, TableMessage, Td, Th } from '@/components/ui/table';
import { fmtDateTime, nf } from '@/lib/format';
import { collaboratorsPage, verifyPageInfo } from '@/server/services/security';
import { operacaoOuNull } from '../_operacao';

export const metadata = { title: 'Colaboradores · Maturador + Anti-golpista' };
export const dynamic = 'force-dynamic';

/**
 * Verificação de colaboradores: busca com histórico, lista (chips da operação automáticos + manual/CSV) e contadores.
 * Colaborador verificado também pode ser admin (allowlist do anti-golpista). Página pública /verificar/<slug>: só
 * responde "é / não é da equipe".
 */
export default async function ColaboradoresPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await operacaoOuNull(id))) notFound(); // também exige sessão de admin
  const [p, pub] = await Promise.all([collaboratorsPage(id), verifyPageInfo(id)]);
  const accountLabel = (a: { jid: string | null; lid: string | null }) =>
    a.jid ? `+${a.jid.split('@')[0]}` : a.lid ? `${a.lid}@lid` : 'sem número';

  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-sm text-muted">
        Telefones oficiais da equipe. Consulte se um número que abordou alguém do grupo é mesmo da equipe. Colaboradores também
        são aceitos como admin pelo anti-golpista.
      </p>

      <Card className="p-5">
        <h3 className="mb-3 text-base font-semibold text-fg">Este número é colaborador?</h3>
        <VerifyBox campaignId={id} />
        <p className="mt-3 text-xs text-muted" data-testid="verify-counts">
          {nf.format(p.counts.total)} consulta(s) · {nf.format(p.counts.positives)} confirmada(s)
        </p>
      </Card>

      <Card className="p-5">
        <h3 className="mb-3 text-base font-semibold text-fg">Página pública de verificação</h3>
        <PublicVerifyPage campaignId={id} slug={pub.slug} enabled={pub.enabled} eventName={pub.eventName} />
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0 space-y-2">
          <h3 className="text-base font-semibold text-fg">Colaboradores</h3>
          <CollaboratorsManager
            campaignId={id}
            rows={p.list.map((r) => ({ id: r.id, number: r.number, lid: r.lid, name: r.name, source: r.source }))}
          />
        </div>
        <Section title="Administradores dos chips da operação" flush className="self-start">
          <ul className="divide-y divide-border text-sm">
            {p.accounts.map((a) => (
              <li key={a.id} className="flex justify-between gap-3 px-5 py-2.5">
                <span className="min-w-0 truncate text-fg">{a.name}</span>
                <span className="font-mono text-xs text-muted">{accountLabel(a)}</span>
              </li>
            ))}
            {!p.accounts.length && <li className="px-5 py-3 text-muted">Nenhum chip na operação.</li>}
          </ul>
        </Section>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="min-w-0 space-y-2">
          <h3 className="text-base font-semibold text-fg">Histórico de consultas</h3>
          <Table data-testid="verify-history">
            <thead>
              <tr>
                <Th>Quando</Th>
                <Th>Número</Th>
                <Th>Origem</Th>
                <Th>Resultado</Th>
              </tr>
            </thead>
            <tbody>
              {p.history.map((h) => (
                <tr key={h.id}>
                  <Td className="whitespace-nowrap tabular-nums">{fmtDateTime(h.createdAt)}</Td>
                  <Td className="font-mono text-xs">{h.number ?? h.lid ?? h.query}</Td>
                  <Td className="text-xs">{h.channel}</Td>
                  <Td>
                    <Badge tone={h.result ? 'ok' : 'bad'}>{h.result ? 'Colaborador' : 'Não é'}</Badge>
                  </Td>
                </tr>
              ))}
              {!p.history.length && (
                <TableMessage colSpan={4}>
                  <EmptyState
                    compact
                    className="rounded-none border-0"
                    title="Nenhuma consulta ainda."
                    description="Use a caixa “Este número é colaborador?” acima para a primeira verificação."
                  />
                </TableMessage>
              )}
            </tbody>
          </Table>
        </div>
        <Section title="Mais consultados" flush className="self-start">
          {p.counts.byNumber.length ? (
            <ul className="divide-y divide-border text-sm">
              {p.counts.byNumber.slice(0, 10).map((n) => (
                <li key={n.key} className="flex justify-between gap-3 px-5 py-2">
                  <span className="font-mono text-xs text-fg">{n.key}</span>
                  <span className="tabular-nums text-muted">
                    {nf.format(n.total)} ({nf.format(n.positives)} sim)
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-3 text-sm text-muted">Nenhum número consultado ainda.</p>
          )}
        </Section>
      </div>
    </div>
  );
}
