import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Cabeçalho de tela: título (h1), subtítulo opcional e ações à direita (botão primário por último).
 * `back` mostra "‹ Voltar para …" acima do título.
 */
export function PageHeader({
  title,
  description,
  actions,
  back,
  meta,
  upper,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
  /** selos/infos ao lado do título (ex.: status) */
  meta?: ReactNode;
  /** título em caixa alta p/ telas de entrada/vitrine */
  upper?: boolean;
  className?: string;
}) {
  return (
    <header className={cn('mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4', className)}>
      <div className="min-w-0 grow basis-72">
        {back && (
          <Link
            href={back.href}
            className="mb-1.5 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
          >
            <span aria-hidden>‹</span> {back.label}
          </Link>
        )}
        <div className="flex flex-wrap items-center gap-2.5">
          <h1
            className={cn(
              'font-heading text-[38px] font-bold leading-none tracking-[-0.01em] text-fg min-[861px]:text-[46px]',
              upper && 'uppercase tracking-[0.01em]',
            )}
          >
            {title}
          </h1>
          {meta}
        </div>
        {description && <p className="mt-2 max-w-[72ch] text-[15px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
