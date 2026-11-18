'use client';

import type { ReactNode } from 'react';
import { confirmar } from '@/components/ui/confirm';

/**
 * Botão de formulário que pede confirmação antes de enviar (ex.: "Descartar" na lista da agenda).
 * Usa o diálogo do painel (`confirmar`); só envia o formulário (com este botão como submitter) se confirmar.
 */
export function ConfirmSubmit({
  pergunta,
  titulo,
  confirmar: verbo,
  className,
  title,
  children,
}: {
  pergunta: string;
  /** pergunta curta do diálogo (padrão: a própria `pergunta`) */
  titulo?: string;
  /** verbo do botão de confirmar (ex.: "Descartar") */
  confirmar?: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      className={className}
      title={title}
      onClick={async (e) => {
        e.preventDefault();
        const button = e.currentTarget;
        const form = button.form;
        const ok = await confirmar({
          title: titulo ?? pergunta,
          message: titulo ? pergunta : undefined,
          confirmLabel: verbo ?? 'Confirmar',
          tone: 'danger',
        });
        if (ok && form) form.requestSubmit(button);
      }}
    >
      {children}
    </button>
  );
}
