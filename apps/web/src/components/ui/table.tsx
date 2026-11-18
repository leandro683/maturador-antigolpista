import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * Tabela padrão: moldura com rolagem horizontal (mobile), cabeçalho fixo, zebra sutil e hover.
 * Os estilos de linha ficam em `.mag-table` (globals.css) p/ valerem também em <tr> gerados por módulos.
 * `maxHeight` ativa rolagem vertical com o cabeçalho grudado no topo.
 * `stack`: em telas estreitas (≤ 640px) cada linha vira um cartão (sem cabeçalho) em vez de rolar para o lado, para as ações não ficarem escondidas.
 */
export function Table({
  className,
  wrapClassName,
  maxHeight,
  stack,
  children,
  ...rest
}: HTMLAttributes<HTMLTableElement> & { wrapClassName?: string; maxHeight?: string; stack?: boolean }) {
  return (
    <div
      className={cn(
        'mag-table-wrap overflow-x-auto rounded-xl border border-border bg-card shadow-card',
        wrapClassName,
      )}
      style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}
    >
      <table className={cn('mag-table w-full text-sm', stack && 'mag-table-stack', className)} {...rest}>
        {children}
      </table>
    </div>
  );
}

export function Th({
  numeric,
  className,
  children,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean; children?: ReactNode }) {
  return (
    <th scope="col" className={cn(numeric ? 'text-right' : 'text-left', className)} {...rest}>
      {children}
    </th>
  );
}

export function Td({
  numeric,
  className,
  children,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean; children?: ReactNode }) {
  return (
    <td className={cn(numeric && 'text-right tabular-nums', className)} {...rest}>
      {children}
    </td>
  );
}

/** Linha única ocupando a tabela inteira (estado vazio/carregando dentro do <tbody>). */
export function TableMessage({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr className="mag-table-message">
      <td colSpan={colSpan} className="!p-0">
        {children}
      </td>
    </tr>
  );
}

/** Esqueleto de carregamento (use em loading.tsx ou enquanto busca no cliente). */
export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div
      role="status"
      aria-label="Carregando…"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-card"
    >
      <div className="h-10 border-b border-border bg-subtle" />
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 border-b border-border px-4 py-3 last:border-0">
          {Array.from({ length: cols }, (_, c) => (
            <span key={c} className="h-3.5 flex-1 animate-pulse rounded bg-subtle" />
          ))}
        </div>
      ))}
    </div>
  );
}
