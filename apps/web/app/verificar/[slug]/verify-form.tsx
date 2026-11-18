'use client';

import { useState, useTransition } from 'react';
import { buttonClass } from '@/components/ui/button';
import { Alert, inputClass } from '@/components/ui/form';
import type { PublicVerifyResult } from '@/server/services/public-verify';
import { publicVerifyAction } from './actions';

const TEXT: Record<PublicVerifyResult['status'], { tone: 'ok' | 'bad' | 'warn'; text: string }> = {
  equipe: { tone: 'ok', text: 'Este número é da equipe.' },
  'nao-equipe': { tone: 'bad', text: 'Este número NÃO é da equipe. Não passe dados nem faça pagamentos.' },
  invalido: { tone: 'warn', text: 'Número inválido. Digite com DDD, ex.: (11) 99999-0000.' },
  limite: { tone: 'warn', text: 'Muitas consultas seguidas. Aguarde um minuto e tente de novo.' },
  indisponivel: { tone: 'warn', text: 'Verificação indisponível no momento.' },
};

export function VerifyForm({ slug }: { slug: string }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<PublicVerifyResult | null>(null);
  const [pending, start] = useTransition();
  const shown = res ? TEXT[res.status] : null;
  return (
    <form
      className="mt-6 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setRes(await publicVerifyAction(slug, q)));
      }}
    >
      <label className="block text-sm font-medium text-fg" htmlFor="numero">
        Número de WhatsApp
      </label>
      <div className="flex gap-2">
        <input
          id="numero"
          inputMode="tel"
          autoComplete="off"
          className={`${inputClass} min-w-0 flex-1`}
          placeholder="(11) 99999-0000"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setRes(null);
          }}
        />
        <button type="submit" className={buttonClass('primary')} disabled={pending || !q.trim()}>
          {pending ? 'Verificando…' : 'Verificar'}
        </button>
      </div>
      {shown && (
        <div data-testid="verify-public-result">
          <Alert tone={shown.tone}>{shown.text}</Alert>
        </div>
      )}
    </form>
  );
}
