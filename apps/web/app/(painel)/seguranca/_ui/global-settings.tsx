'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveGlobalSecurityAction } from '../actions';
import { Section } from '@/components/ui/card';
import { checkboxClass } from '@/components/ui/form';

type Settings = { antiSpamAssociatedOnly: boolean; sharedBlocklistAllCampaigns: boolean };

const ITEMS: { key: keyof Settings; label: string; on: string; off: string }[] = [
  {
    key: 'antiSpamAssociatedOnly',
    label: 'Anti-spam: agir só pelas contas associadas à operação',
    on: 'Ligado (recomendado): só os números ligados à operação apagam mensagens e removem invasores.',
    off:
      'Desligado: se nenhum número da operação estiver conectado no grupo, outra conta sua que esteja no grupo ' +
      'pode agir no lugar. Contas suas nunca são tratadas como invasores.',
  },
  {
    key: 'sharedBlocklistAllCampaigns',
    label: 'Lista de bloqueados compartilhada em todas as operações',
    on: 'Ligado: quem cair no anti-spam compartilhado é recusado e removido em TODAS as operações.',
    off: 'Desligado (padrão): a lista compartilhada só vale nas operações que aderiram (lista abaixo).',
  },
];

/** Interruptores globais do anti-spam. Cada mudança fica no histórico. */
export function GlobalSecuritySettings({
  initial,
  updatedAt,
}: {
  initial: Settings;
  updatedAt: string | null;
}) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const toggle = (key: keyof Settings, value: boolean) => {
    const prev = v;
    setV({ ...v, [key]: value });
    start(async () => {
      const r = await saveGlobalSecurityAction({ [key]: value });
      if (!r.ok) {
        setV(prev);
        setMsg({ ok: false, text: r.error });
        return;
      }
      setMsg({ ok: true, text: 'Salvo. Os robôs passam a usar a nova regra em até 1 minuto.' });
      router.refresh();
    });
  };

  return (
    <Section
      data-testid="global-security"
      title="Regras gerais do anti-spam"
      description={
        <>
          Valem para todas as operações.{' '}
          Toda mudança fica registrada no histórico.
          {updatedAt && ` Última mudança: ${updatedAt}.`}
        </>
      }
    >
      <div className="divide-y divide-border">
        {ITEMS.map((it) => (
          <label
            key={it.key}
            className="flex cursor-pointer items-start justify-between gap-4 py-3 text-sm first:pt-0 last:pb-0"
          >
            <span>
              <span className="font-medium text-fg">{it.label}</span>
              <span className="mt-0.5 block text-xs text-muted">{v[it.key] ? it.on : it.off}</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-label={it.label}
              className={`mt-1 ${checkboxClass}`}
              checked={v[it.key]}
              disabled={pending}
              onChange={(e) => toggle(it.key, e.target.checked)}
            />
          </label>
        ))}
      </div>
      {msg && (
        <p role="status" className={`mt-3 text-sm font-medium ${msg.ok ? 'text-ok' : 'text-bad'}`}>
          {msg.text}
        </p>
      )}
    </Section>
  );
}
