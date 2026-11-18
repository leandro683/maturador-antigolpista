'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

type ToastTone = 'ok' | 'bad' | 'info';
type Item = { id: number; text: string; tone: ToastTone };

let add: ((t: Omit<Item, 'id'>) => void) | null = null;

/** Aviso passageiro no canto da tela ("Campanha salva."). Precisa de `<Toaster/>` no layout. */
export function toast(text: string, tone: ToastTone = 'ok') {
  add?.({ text, tone });
}

const ICON: Record<ToastTone, string> = { ok: '✓', bad: '!', info: 'i' };
const TONE: Record<ToastTone, string> = {
  ok: 'bg-ok text-bad-fg',
  bad: 'bg-bad text-bad-fg',
  info: 'bg-info text-bad-fg',
};

export function Toaster() {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    let seq = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    add = (t) => {
      const id = ++seq;
      setItems((xs) => [...xs.slice(-2), { ...t, id }]);
      const tm = setTimeout(
        () => {
          timers.delete(tm);
          setItems((xs) => xs.filter((x) => x.id !== id));
        },
        t.tone === 'bad' ? 7000 : 4000,
      );
      timers.add(tm);
    };
    return () => {
      add = null;
      timers.forEach(clearTimeout);
    };
  }, []);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-6"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className="mag-toast pointer-events-auto flex max-w-sm items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm text-fg shadow-pop"
        >
          <span
            className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold',
              TONE[t.tone],
            )}
            aria-hidden
          >
            {ICON[t.tone]}
          </span>
          {t.text}
        </div>
      ))}
    </div>
  );
}
