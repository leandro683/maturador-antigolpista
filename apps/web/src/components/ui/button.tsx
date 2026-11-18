import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerSolid' | 'pill';
export type ButtonSize = 'sm' | 'md';

// botões do kit (pecas.css .btn): Inter 600 14px, raio 8, ícone 18px, afunda 1px ao clicar
const BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border text-sm font-semibold transition-[background-color,border-color,color,transform] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0 [&_svg]:size-[18px] [&_svg]:shrink-0';

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3',
  md: 'h-10 px-4',
};

export const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-accent text-accent-fg hover:not-disabled:bg-accent-hover',
  secondary: 'border-border bg-card text-fg hover:not-disabled:border-muted',
  ghost: 'border-transparent text-fg hover:not-disabled:bg-card',
  danger: 'border-bad/40 bg-card text-bad hover:not-disabled:bg-bad-soft',
  dangerSolid: 'border-transparent bg-bad text-bad-fg hover:not-disabled:opacity-90',
  // pílula do kit: filtro/atalho compacto (32px, raio total, 13px 500), em qualquer tamanho
  pill: 'h-8 rounded-full border-border bg-card px-3 text-[13px] font-medium text-fg hover:not-disabled:border-accent hover:not-disabled:bg-info-soft',
};

/** Classe de botão (use em <button>, <Link> e <a>). Um único `primary` por formulário/tela. */
export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  className?: string,
) {
  return cn(BASE, SIZE[size], BUTTON_VARIANT[variant], className);
}

/**
 * Partes soltas no formato antigo (`cn(btn.base, btn.primary)`) — mantidas p/ as telas que já usam.
 * `base` = tamanho `sm` (o mais comum nas tabelas e barras de ação).
 */
export const btnParts = {
  base: cn(BASE, SIZE.sm),
  primary: BUTTON_VARIANT.primary,
  secondary: BUTTON_VARIANT.secondary,
  ghost: BUTTON_VARIANT.ghost,
  danger: BUTTON_VARIANT.danger,
};

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize };

export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...rest }: Props) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}
