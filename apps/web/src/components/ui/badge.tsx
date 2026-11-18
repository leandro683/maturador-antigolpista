import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Tons semânticos. `off` = desligado/arquivado (neutro apagado). */
export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'accent' | 'off';

export const TONE_SOFT: Record<Tone, string> = {
  neutral: 'bg-bg text-muted',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
  accent: 'bg-info-soft text-info',
  off: 'bg-bg text-muted',
};

export const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-muted',
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  info: 'bg-info',
  accent: 'bg-accent',
  off: 'bg-muted/60',
};

type Props = {
  tone?: Tone;
  /** bolinha à esquerda (status ao vivo: conectado, rodando…) */
  dot?: boolean;
  className?: string;
  children: ReactNode;
} & Record<`data-${string}`, string | undefined>;

/** Selo de status: cor semântica + texto em português (a cor nunca é a única pista). */
export function Badge({ tone = 'neutral', dot, className, children, ...data }: Props) {
  return (
    <span
      {...data}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 py-[3px] text-xs font-semibold leading-[1.4]',
        TONE_SOFT[tone],
        className,
      )}
    >
      {dot && <span className={cn('size-1.5 rounded-full', TONE_DOT[tone])} aria-hidden />}
      {children}
    </span>
  );
}
