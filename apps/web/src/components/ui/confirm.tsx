'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { buttonClass } from './button';

export type ConfirmOptions = {
  /** pergunta curta ("Arquivar este deeplink?") */
  title: string;
  /** o que vai acontecer, em linguagem simples */
  message?: ReactNode;
  /** texto do botão de confirmar — o verbo da ação ("Arquivar"), nunca "OK" */
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` p/ ações destrutivas ou irreversíveis */
  tone?: 'danger' | 'default';
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };
let push: ((p: Pending) => void) | null = null;

/**
 * Pergunta de confirmação com texto claro. Precisa de `<ConfirmHost/>` montado (layout do painel);
 * sem ele cai no `window.confirm` do navegador.
 */
export function confirmar(opts: ConfirmOptions): Promise<boolean> {
  if (!push) {
    const plain = typeof opts.message === 'string' ? `${opts.title}\n\n${opts.message}` : opts.title;
    return Promise.resolve(window.confirm(plain));
  }
  return new Promise((resolve) => push!({ ...opts, resolve }));
}

export function ConfirmHost() {
  const [cur, setCur] = useState<Pending | null>(null);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    push = (p) =>
      setCur((prev) => {
        prev?.resolve(false);
        return p;
      });
    return () => {
      push = null;
    };
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (cur && d && !d.open) d.showModal();
  }, [cur]);

  function done(ok: boolean) {
    cur?.resolve(ok);
    ref.current?.close();
    setCur(null);
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="mag-confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        done(false);
      }}
      className="mag-dialog w-[min(28rem,calc(100vw-2rem))]"
    >
      {cur && (
        <div className="p-5">
          <h2 id="mag-confirm-title" className="font-heading text-xl font-semibold text-fg">
            {cur.title}
          </h2>
          {cur.message && <div className="mt-2 text-sm text-muted">{cur.message}</div>}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className={buttonClass('secondary')} onClick={() => done(false)}>
              {cur.cancelLabel ?? 'Cancelar'}
            </button>
            <button
              type="button"
              autoFocus
              className={buttonClass(cur.tone === 'danger' ? 'dangerSolid' : 'primary')}
              onClick={() => done(true)}
            >
              {cur.confirmLabel ?? 'Confirmar'}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
