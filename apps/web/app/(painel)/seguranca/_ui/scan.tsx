'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { cancelScanAction, startScanAction } from '../actions';
import { Badge, type Tone } from '@/components/ui/badge';
import { buttonClass } from '@/components/ui/button';
import { Section } from '@/components/ui/card';
import { checkboxClass, inputClass } from '@/components/ui/form';
import { SelectSearch } from '@/components/ui/select-search';

export type ScanRowView = {
  id: string;
  campaignId: string | null;
  campaign: string | null;
  status: string;
  total: number;
  processed: number;
  failed: number;
  createdAt: string;
  findings: number;
  open: number;
  messagesUnavailable: number;
  profilesSkipped: number;
  messageLimit: number;
  active: boolean;
};

const STATUS: Record<string, string> = {
  queued: 'Na fila',
  scheduled: 'Agendada',
  processing: 'Analisando',
  paused: 'Pausada',
  success: 'Concluída',
  failed: 'Concluída com erros',
  canceled: 'Cancelada',
};

const STATUS_TONE: Record<string, Tone> = {
  queued: 'neutral',
  scheduled: 'neutral',
  processing: 'info',
  paused: 'warn',
  success: 'ok',
  failed: 'bad',
  canceled: 'off',
};

/**
 * "Analisar grupos": inicia a varredura, mostra o progresso (grupos analisados/total,
 * achados) e permite cancelar. Enquanto houver análise em andamento a tela se atualiza sozinha a cada 10 s.
 */
export function ScanPanel({
  campaigns,
  fixedCampaignId,
  fixedImpersonation,
  fixedEnabled,
  scans,
  adminCount,
}: {
  /** `impersonation` = modo de impostores da operação; `enabled` = anti-golpista ligado (a conferência de perfis só vale com os dois) */
  campaigns: { id: string; name: string; impersonation?: string; enabled?: boolean }[];
  /** na aba da operação: sem seletor */
  fixedCampaignId?: string;
  fixedImpersonation?: string;
  fixedEnabled?: boolean;
  scans: ScanRowView[];
  adminCount: number;
}) {
  const router = useRouter();
  const [campaignId, setCampaignId] = useState(fixedCampaignId ?? '');
  const [limit, setLimit] = useState(50);
  const [checkProfiles, setCheckProfiles] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const anyActive = scans.some((s) => s.active);
  const picked = fixedCampaignId ? { impersonation: fixedImpersonation, enabled: fixedEnabled } : campaigns.find((c) => c.id === campaignId);
  const impOff = picked?.impersonation === 'off' || picked?.enabled === false;

  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [anyActive, router]);

  const begin = () =>
    start(async () => {
      const r = await startScanAction(campaignId, limit, checkProfiles && !impOff);
      setMsg(
        r.ok
          ? {
              ok: true,
              text: 'Análise iniciada. Os grupos são lidos um de cada vez por conta, com pausa entre eles.',
            }
          : { ok: false, text: r.error },
      );
      if (r.ok) router.refresh();
    });

  const cancel = (id: string) =>
    start(async () => {
      const r = await cancelScanAction(id);
      setMsg(r.ok ? { ok: true, text: 'Análise cancelada.' } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });

  return (
    <Section
      data-testid="scan-panel"
      title="Analisar grupos"
      description={
        <>
          Passa por todos os grupos da operação procurando números bloqueados, administradores que não são da
          equipe e mensagens de quem não é admin em grupos fechados.{' '}
          <strong className="text-fg">Esta análise, iniciada por aqui, não remove nada sozinha</strong>: cada
          achado aparece abaixo e você decide se remove, apaga ou ignora. A análise diária automática é outra e só
          age sozinha se você ligou o modo automático de impostores e a análise automática.
        </>
      }
    >
      <div className="space-y-4">
        {adminCount === 0 && (
          <p
            role="alert"
            className="rounded-lg border border-warn/30 bg-warn-soft px-4 py-2.5 text-sm text-warn"
          >
            Cadastre os números administrativos antes: sem eles, toda mensagem e todo admin vira achado.
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          {!fixedCampaignId && (
            <label className="block w-full text-sm sm:w-72">
              <span className="mb-1 block font-medium text-fg">Operação</span>
              <SelectSearch
                aria-label="Operação a analisar"
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                options={campaigns.map((c) => ({ value: c.id, label: c.name }))}
                emptyOption="Escolha…"
                placeholder="Buscar operação…"
              />
            </label>
          )}
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-fg">Mensagens lidas por grupo</span>
            <input
              type="number"
              min={0}
              max={200}
              aria-label="Mensagens lidas por grupo"
              value={limit}
              onChange={(e) => setLimit(Math.max(0, Math.min(200, Number(e.target.value) || 0)))}
              className={`${inputClass} w-28`}
            />
          </label>
          <button className={buttonClass('primary')} disabled={pending || !campaignId} onClick={begin}>
            Analisar grupos
          </button>
          <label className="flex w-full items-start gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className={`${checkboxClass} mt-0.5`}
              checked={checkProfiles && !impOff}
              disabled={impOff}
              onChange={(e) => setCheckProfiles(e.target.checked)}
            />
            <span>
              Conferir foto e nome dos participantes (demora mais e pode deixar a conta mais lenta)
              {impOff && (
                <span className="block text-xs text-muted">
                  Ligue a detecção de impostores nesta operação para usar.
                </span>
              )}
            </span>
          </label>
          {msg && (
            <span role="status" className={`text-sm font-medium ${msg.ok ? 'text-ok' : 'text-bad'}`}>
              {msg.text}
            </span>
          )}
        </div>

        {scans.length > 0 && (
          <ul
            className="divide-y divide-border rounded-lg border border-border text-sm"
            aria-label="Análises recentes"
          >
            {scans.map((s) => {
              const pct = s.total ? Math.round((s.processed / s.total) * 100) : s.active ? 0 : 100;
              return (
                <li key={s.id} className="space-y-1.5 px-3 py-2.5" data-testid="scan-row">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge tone={STATUS_TONE[s.status] ?? 'neutral'} dot={s.active}>
                        {STATUS[s.status] ?? s.status}
                      </Badge>
                      {!fixedCampaignId && s.campaign && <span className="text-fg">{s.campaign}</span>}
                      <span className="text-xs tabular-nums text-muted">{s.createdAt}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-3">
                      <span className="tabular-nums" data-testid="scan-progress">
                        {s.processed}/{s.total} grupos
                      </span>
                      <Link
                        href={`/seguranca?analise=${s.id}${s.open ? '&abertos=1' : ''}`}
                        className="font-medium text-accent hover:underline"
                        data-testid="scan-findings"
                      >
                        {s.findings} achado(s){s.open ? ` · ${s.open} em aberto` : ''}
                      </Link>
                      {s.active && (
                        <button
                          className={buttonClass('ghost', 'sm')}
                          disabled={pending}
                          onClick={() => cancel(s.id)}
                        >
                          Cancelar
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-subtle" aria-hidden>
                    <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                  {s.failed > 0 && (
                    <p className="text-xs font-medium text-bad">
                      {s.failed} grupo(s) não puderam ser analisados.
                    </p>
                  )}
                  {s.profilesSkipped > 0 && (
                    <p className="text-xs text-warn" data-testid="scan-profiles-warning">
                      {s.profilesSkipped} perfil(is) não puderam ser conferidos.
                    </p>
                  )}
                  {s.messagesUnavailable > 0 && (
                    <p className="text-xs text-warn" data-testid="scan-messages-warning">
                      Em {s.messagesUnavailable} grupo(s) o WhatsApp não devolveu as mensagens recentes: ali
                      só os participantes e administradores foram conferidos.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Section>
  );
}
