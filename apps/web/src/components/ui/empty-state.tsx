import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Estado vazio: ilustração leve, frase do que falta e o próximo passo (CTA). */
export function EmptyState({
  title,
  description,
  action,
  compact,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed border-border-strong bg-card/60 text-center',
        compact ? 'gap-2 px-4 py-5' : 'gap-3 px-6 py-12',
        className,
      )}
    >
      {!compact && (
        <svg viewBox="0 0 64 64" className="size-14 text-accent" fill="none" aria-hidden>
          <circle cx="32" cy="32" r="30" className="fill-accent-soft" />
          <path
            d="M18 36l5-13a3 3 0 0 1 2.8-2h12.4a3 3 0 0 1 2.8 2l5 13v7a3 3 0 0 1-3 3H21a3 3 0 0 1-3-3v-7Z"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinejoin="round"
          />
          <path d="M18 36h8l2 4h8l2-4h8" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
        </svg>
      )}
      <div>
        <p
          className={cn(
            !compact
              ? 'text-base font-medium text-fg'
              : description
                ? 'text-sm font-medium text-fg'
                : 'text-sm text-muted',
          )}
        >
          {title}
        </p>
        {description && <p className="mx-auto mt-1 max-w-md text-sm text-muted">{description}</p>}
      </div>
      {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
