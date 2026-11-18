import Link from 'next/link';
import { buttonClass } from './button';
import { nf } from '@/lib/format';

export type SP = Record<string, string | string[] | undefined>;

/** Monta `base?query` preservando os filtros atuais e aplicando `patch` (null remove a chave). */
export function hrefWith(base: string, sp: SP, patch: Record<string, string | number | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string' && v) p.set(k, v);
    else if (Array.isArray(v)) for (const x of v) p.append(k, x);
  }
  for (const [k, v] of Object.entries(patch)) {
    p.delete(k);
    if (v != null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

/** Paginação por link (`?p=`): "1–50 de 1.186" + Anterior/Próxima. */
export function Pager({
  base,
  sp,
  page,
  pageSize,
  total,
  param = 'p',
}: {
  base: string;
  sp: SP;
  page: number;
  pageSize: number;
  total: number;
  param?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  page = Math.min(Math.max(1, page), pages);
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(page * pageSize, total);
  return (
    <nav
      aria-label="Paginação"
      className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted"
    >
      <span data-testid="pager" className="tabular-nums">
        {nf.format(from)}-{nf.format(to)} de {nf.format(total)}
      </span>
      <div className="flex gap-2">
        {page > 1 && (
          <Link className={buttonClass('secondary', 'sm')} href={hrefWith(base, sp, { [param]: page - 1 })}>
            ‹ Anterior
          </Link>
        )}
        {page < pages && (
          <Link className={buttonClass('secondary', 'sm')} href={hrefWith(base, sp, { [param]: page + 1 })}>
            Próxima ›
          </Link>
        )}
      </div>
    </nav>
  );
}
