'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveVerifyPageAction } from '../actions';
import { buttonClass } from '@/components/ui/button';
import { checkboxClass, inputClass } from '@/components/ui/form';

/** Link da página pública /verificar/<slug>, liga/desliga e nome do evento (título da página). */
export function PublicVerifyPage(props: {
  campaignId: string;
  slug: string;
  enabled: boolean;
  eventName: string | null;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(props.enabled);
  const [eventName, setEventName] = useState(props.eventName ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const path = `/verificar/${props.slug}`;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveVerifyPageAction(props.campaignId, { enabled, eventName });
          setMsg(r.ok ? 'Salvo.' : r.error);
          router.refresh();
        });
      }}
    >
      <p className="text-sm text-muted">
        Qualquer pessoa digita um número e vê só se ele é ou não da equipe — a lista nunca aparece.
      </p>
      <p className="text-sm">
        <a
          href={path}
          target="_blank"
          rel="noreferrer"
          className="break-all font-mono text-accent hover:underline"
          data-testid="verify-page-link"
        >
          {path}
        </a>
      </p>
      <label className="flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          className={checkboxClass}
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Página pública ligada
      </label>
      <label className="block text-sm text-fg">
        <span className="mb-1 block text-xs font-medium text-muted">Nome do evento (título da página)</span>
        <input
          className={`${inputClass} max-w-sm`}
          value={eventName}
          maxLength={120}
          placeholder="Verificação da equipe"
          onChange={(e) => setEventName(e.target.value)}
        />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" className={buttonClass('primary', 'sm')} disabled={pending}>
          Salvar
        </button>
        {msg && (
          <span role="status" className="text-sm text-muted">
            {msg}
          </span>
        )}
      </div>
    </form>
  );
}
