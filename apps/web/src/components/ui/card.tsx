import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

// bloco do kit: branco, raio 16, plano (sem borda nem sombra) sobre o gelo
export const cardClass = 'rounded-xl bg-card';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(cardClass, className)} {...rest} />;
}

/** Bloco com título (h2), descrição curta e ações à direita. `flush` tira o padding do corpo (tabelas). */
export function Section({
  title,
  description,
  actions,
  flush,
  className,
  children,
  ...rest
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <section className={cn(cardClass, className)} {...rest}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 px-6 pb-4 pt-5">
          <div className="min-w-0">
            {title && <h2 className="font-heading text-[28px] font-bold leading-[1.1]">{title}</h2>}
            {description && <p className="mt-1 text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? undefined : title || actions ? 'px-6 pb-6' : 'p-6'}>{children}</div>
    </section>
  );
}
