import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { LinkTabs } from '@/components/ui/tabs';
import { PageHeader } from '@/components/ui/page-header';
import { operacaoOuNull } from './_operacao';

export const dynamic = 'force-dynamic';

/** Cabeçalho comum da operação, com as abas Grupos / Anti-golpista / Colaboradores. */
export default async function OperacaoLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const op = await operacaoOuNull(id);
  if (!op) notFound();
  return (
    <section>
      <PageHeader back={{ href: '/grupos', label: 'Operações' }} title={op.name} />
      <LinkTabs
        label="Seções da operação"
        className="mb-6"
        items={[
          { href: `/grupos/${id}`, label: 'Grupos e chips', match: 'exact' },
          { href: `/grupos/${id}/anti-golpista`, label: 'Anti-golpista' },
          { href: `/grupos/${id}/colaboradores`, label: 'Colaboradores' },
        ]}
      />
      {children}
    </section>
  );
}
