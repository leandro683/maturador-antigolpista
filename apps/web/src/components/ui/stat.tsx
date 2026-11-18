import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { cardClass } from './card';

const pct = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1, signDisplay: 'exceptZero' });

/**
 * Indicador: número grande + rótulo + variação opcional (`delta` em %, positivo = verde).
 * `invert` p/ métricas em que subir é ruim (saídas, erros).
 */
export function Stat({
  label,
  value,
  hint,
  delta,
  invert,
  className,
  ...data
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  delta?: number | null;
  invert?: boolean;
  className?: string;
} & Record<`data-${string}`, string | undefined>) {
  const good = delta == null || delta === 0 ? null : delta > 0 !== Boolean(invert);
  return (
    <div className={cn(cardClass, 'px-5 pb-4 pt-[18px]', className)} {...data}>
      <p className="text-sm font-semibold text-muted">{label}</p>
      <p className="mt-2 font-heading text-[40px] font-bold leading-[1.05] tracking-[-0.01em] tabular-nums text-fg">
        {value}
      </p>
      {(hint || delta != null) && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
          {delta != null && (
            <span
              className={cn(
                'font-medium tabular-nums',
                good == null ? 'text-muted' : good ? 'text-ok' : 'text-bad',
              )}
            >
              <span aria-hidden>{delta > 0 ? '▲' : delta < 0 ? '▼' : '•'}</span> {pct.format(delta)}%
            </span>
          )}
          {hint}
        </p>
      )}
    </div>
  );
}
