import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Campo de texto/select/textarea padrão (sem altura fixa: serve p/ textarea). */
export const inputClass =
  'w-full rounded-md border border-border bg-card px-2.5 py-2 text-sm text-fg outline-none transition-colors placeholder:text-muted hover:border-muted/70 focus:border-accent focus:ring-2 focus:ring-accent disabled:cursor-not-allowed disabled:bg-subtle disabled:opacity-70 aria-[invalid=true]:border-bad';

export const checkboxClass = 'size-4 rounded border-border-strong accent-[var(--color-accent)]';

/**
 * Rótulo acima do campo, ajuda abaixo e erro inline (vermelho, com ícone). O <label> envolve o controle,
 * então o `getByLabel` continua achando o campo pelo texto do rótulo.
 */
export function Field({
  label,
  hint,
  error,
  required,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn('block text-sm', className)}>
      <span className="mb-1.5 block text-[13px] font-medium text-muted">
        {label}
        {required && (
          <span className="text-bad" aria-hidden>
            {' '}
            *
          </span>
        )}
      </span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-muted">{hint}</span>}
      {error && <FieldError>{error}</FieldError>}
    </label>
  );
}

export function FieldError({ children }: { children: ReactNode }) {
  return (
    <span role="alert" className="mt-1 flex items-center gap-1 text-xs font-medium text-bad">
      <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="currentColor" aria-hidden>
        <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm-.75 3.25h1.5v4.5h-1.5v-4.5Zm0 5.75h1.5V12h-1.5v-1.5Z" />
      </svg>
      {children}
    </span>
  );
}

/** Caixa de aviso/resultado (sucesso, erro, aviso, info) — use p/ feedback que precisa ficar na tela. */
export function Alert({
  tone = 'info',
  title,
  children,
  className,
  action,
  role,
}: {
  /** padrão: `alert` p/ erro, `status` nos outros tons */
  role?: 'alert' | 'status';
  tone?: 'ok' | 'warn' | 'bad' | 'info';
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  // aviso do kit: ok e info em info-fundo + azul-escuro, aviso em aviso-fundo, erro em erro-fundo + vermelho
  const TONE = {
    ok: 'bg-info-soft text-info',
    warn: 'bg-warn-soft text-warn',
    bad: 'bg-bad-soft text-bad',
    info: 'bg-info-soft text-info',
  } as const;
  const Icone = { ok: CircleCheck, warn: TriangleAlert, bad: CircleAlert, info: Info }[tone];
  return (
    <div
      role={role ?? (tone === 'bad' ? 'alert' : 'status')}
      className={cn(
        'flex flex-wrap items-start gap-x-2.5 gap-y-3 rounded-[12px] px-3.5 py-3 font-medium',
        TONE[tone],
        className,
      )}
    >
      <Icone className="size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 basis-48">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5')}>{children}</div>}
      </div>
      {action}
    </div>
  );
}
