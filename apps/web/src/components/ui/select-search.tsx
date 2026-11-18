'use client';

import { useId, useMemo, useState, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { inputClass } from './form';

export type SelectOption = { value: string; label: string };

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/**
 * Select com busca p/ listas grandes (300 campanhas): uma caixa "Buscar…" filtra as opções de um <select>
 * nativo — continua acessível, funciona em formulário (name) e no `selectOption` dos testes.
 * A busca vem DEPOIS do <select> no DOM (aparece acima via flex-col-reverse) p/ o <label> que envolve o
 * componente continuar apontando p/ o select. Abaixo de `threshold` opções, vira um select comum. A opção marcada nunca some do filtro.
 */
export function SelectSearch({
  options,
  placeholder,
  emptyOption,
  threshold = 12,
  searchLabel = 'Filtrar opções da lista',
  className,
  value,
  defaultValue,
  onChange,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & {
  options: SelectOption[];
  /** texto da busca (ex.: "Buscar campanha…") */
  placeholder?: string;
  /** 1ª opção vazia (ex.: "Todas as campanhas") */
  emptyOption?: string;
  threshold?: number;
  searchLabel?: string;
}) {
  const [q, setQ] = useState('');
  // sem valor nem opção vazia o navegador marca a 1ª opção: guardar isso evita que o filtro a esconda e o
  // valor do formulário mude sozinho
  const [cur, setCur] = useState<string>(() => {
    const v = value ?? defaultValue;
    if (v != null && (emptyOption != null || options.some((o) => o.value === String(v)))) return String(v);
    return emptyOption != null ? '' : (options[0]?.value ?? '');
  });
  const id = useId();
  const selected = value != null ? String(value) : cur;
  const shown = useMemo(() => {
    const n = norm(q.trim());
    if (!n) return options;
    return options.filter((o) => o.value === selected || norm(o.label).includes(n));
  }, [q, options, selected]);
  const big = options.length >= threshold;

  return (
    <span className={cn('flex flex-col-reverse', big && 'gap-1.5', className)}>
      <select
        {...rest}
        value={value}
        defaultValue={value == null ? defaultValue : undefined}
        onChange={(e) => {
          setCur(e.target.value);
          onChange?.(e);
        }}
        className={inputClass}
      >
        {emptyOption != null && <option value="">{emptyOption}</option>}
        {shown.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {big && (
        <span className="relative block">
          <svg
            viewBox="0 0 16 16"
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            id={id}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            // Enter na busca não envia o formulário (antes era só um <select>)
            onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
            placeholder={placeholder ?? 'Buscar…'}
            aria-label={searchLabel}
            disabled={rest.disabled}
            className={cn(inputClass, 'pl-8')}
          />
        </span>
      )}
      {big && q && (
        <span className="order-first block text-xs text-muted">
          {shown.length === 0 ? 'Nada encontrado.' : `${shown.length} de ${options.length}`}
        </span>
      )}
    </span>
  );
}
