'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

export type TabItem = {
  href: string;
  label: string;
  /** `prefix` (padrão): ativa também em sub-rotas; `exact`: só na própria rota */
  match?: 'prefix' | 'exact';
  /** rotas extras que ativam a aba (ex.: /visao-geral p/ a aba da raiz) */
  also?: string[];
};

export function isTabActive(path: string, t: TabItem): boolean {
  const hit = (h: string) => path === h || (t.match !== 'exact' && path.startsWith(`${h}/`));
  return hit(t.href) || (t.also ?? []).some(hit);
}

// segmento do kit (pecas.css .seg): trilho branco, opção 600 13px suave, atual em navy com texto branco
const SEG_TRACK = 'inline-flex max-w-full gap-0.5 rounded-md bg-card p-1';
const SEG_OPT =
  'whitespace-nowrap rounded-sm px-3 py-[7px] text-[13px] font-semibold leading-[1.2] transition-colors';
const SEG_ON = 'bg-navy text-white';
const SEG_OFF = 'text-muted hover:bg-bg hover:text-fg';

/** Abas de navegação (rotas), no visual de segmento. Rola na horizontal no celular; a atual tem `aria-current="page"`. */
export function LinkTabs({
  items,
  label,
  className,
}: {
  items: TabItem[];
  label: string;
  className?: string;
}) {
  const path = usePathname();
  return (
    <nav aria-label={label} className={cn('mag-scroll-x overflow-x-auto', SEG_TRACK, className)}>
      {items.map((t) => {
        const active = isTabActive(path, t);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={cn(SEG_OPT, active ? SEG_ON : SEG_OFF)}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Abas locais (sem rota): segmento controlado. */
export function SegmentTabs<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cn(SEG_TRACK, className)}>
      {items.map((i) => (
        <button
          key={i.value}
          type="button"
          role="tab"
          aria-selected={i.value === value}
          onClick={() => onChange(i.value)}
          className={cn(SEG_OPT, i.value === value ? SEG_ON : SEG_OFF)}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}
