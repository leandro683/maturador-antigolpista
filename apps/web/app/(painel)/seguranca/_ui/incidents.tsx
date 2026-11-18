'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  antiSpamOptInAction,
  exportIncidentsAction,
  findingsAction,
  resolveIncidentsAction,
} from '../actions';
import { Badge, type Tone } from '@/components/ui/badge';
import { buttonClass } from '@/components/ui/button';
import { confirmar } from '@/components/ui/confirm';
import { EmptyState } from '@/components/ui/empty-state';
import { checkboxClass } from '@/components/ui/form';
import { Table, Td, Th } from '@/components/ui/table';

export type IncidentView = {
  id: string;
  createdAt: string;
  kind: string;
  kindLabel: string;
  status: string;
  statusLabel: string;
  severity: string;
  who: string;
  actor: string | null;
  campaign: string | null;
  group: string | null;
  actions: { type: string; ok: boolean; error?: string }[];
  resolved: boolean;
  reason?: string;
  /** Achado da análise esperando decisão (Remover / Apagar / Ignorar) */
  finding?: boolean;
  /** achado de mensagem (dá p/ apagar) */
  isMessage?: boolean;
  /** trecho da mensagem / observação do achado */
  detail?: string;
};

type FindingOp = 'remove' | 'delete' | 'ignore';
const CONFIRM: Record<
  Exclude<FindingOp, 'ignore'> | 'block',
  { title: string; message: string; confirmLabel: string }
> = {
  remove: {
    title: 'Remover do grupo?',
    message: 'Remover do grupo no WhatsApp os participantes selecionados? Não dá para desfazer pelo painel.',
    confirmLabel: 'Remover',
  },
  block: {
    title: 'Remover e bloquear?',
    message:
      'Remover do grupo no WhatsApp os participantes selecionados e colocá-los também na lista de bloqueados da operação? Não dá para desfazer pelo painel.',
    confirmLabel: 'Remover e bloquear',
  },
  delete: {
    title: 'Apagar mensagem?',
    message: 'Apagar para todos, no WhatsApp, as mensagens selecionadas? Não dá para desfazer.',
    confirmLabel: 'Apagar',
  },
};

const sevTone: Record<string, Tone> = {
  critical: 'bad',
  warning: 'warn',
  info: 'neutral',
};

const STATUS_TONE: Record<string, Tone> = {
  acted: 'ok',
  partial: 'warn',
  failed: 'bad',
  dry_run: 'info',
  rate_limited: 'warn',
  ignored: 'off',
  reverted: 'info',
  open: 'warn',
};

const linkBtn =
  'rounded px-1.5 py-0.5 text-xs font-medium text-accent hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50';

/** Tabela de incidentes com seleção → ignorar (falso positivo) / marcar revertido. */
export function IncidentsTable({ rows }: { rows: IncidentView[] }) {
  const router = useRouter();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const act = (status: 'ignored' | 'reverted') =>
    start(async () => {
      const r = await resolveIncidentsAction([...sel], status);
      setMsg(r.ok ? `${sel.size} incidente(s) atualizado(s).` : r.error);
      if (r.ok) {
        setSel(new Set());
        router.refresh();
      }
    });
  // quem só visualiza (viewer) não vê os botões de decisão — o servidor recusaria
  const open = rows.filter((r) => r.finding && !r.resolved);
  const selFindings = open.filter((r) => sel.has(r.id));
  const decide = async (ids: string[], op: FindingOp, block = false) => {
    if (!ids.length) return;
    if (op !== 'ignore' && !(await confirmar({ ...CONFIRM[block ? 'block' : op], tone: 'danger' }))) return;
    start(async () => {
      const r = await findingsAction(ids, op, block);
      if (!r.ok) return setMsg(r.error);
      const d = r.data;
      setMsg(
        [
          `${d.done} feito(s)`,
          d.failed ? `${d.failed} com erro` : '',
          d.skipped ? `${d.skipped} sem mudança` : '',
          ...d.notes.slice(0, 3),
        ]
          .filter(Boolean)
          .join(' · '),
      );
      setSel(new Set());
      router.refresh();
    });
  };

  if (!rows.length)
    return (
      <EmptyState
        compact
        title="Nenhum incidente com esses filtros."
        description="Quando o anti-golpista agir, cada ação aparece aqui. Para ver tudo, clique em “Limpar” nos filtros."
      />
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className={buttonClass('secondary', 'sm')}
          disabled={!sel.size || pending}
          onClick={() => act('ignored')}
        >
          Ignorar selecionados
        </button>
        <button
          className={buttonClass('secondary', 'sm')}
          disabled={!sel.size || pending}
          onClick={() => act('reverted')}
        >
          Marcar como revertido
        </button>
        {open.length > 0 && (
          <span
            className="flex flex-wrap items-center gap-2 border-l border-border pl-2"
            aria-label="Achados da análise"
          >
            <button
              className={buttonClass('danger', 'sm')}
              disabled={!selFindings.length || pending}
              onClick={() =>
                decide(
                  selFindings.map((r) => r.id),
                  'remove',
                )
              }
            >
              Remover participante
            </button>
            <button
              className={buttonClass('danger', 'sm')}
              disabled={!selFindings.length || pending}
              onClick={() =>
                decide(
                  selFindings.map((r) => r.id),
                  'remove',
                  true,
                )
              }
            >
              Remover e bloquear
            </button>
            <button
              className={buttonClass('danger', 'sm')}
              disabled={!selFindings.some((r) => r.isMessage) || pending}
              onClick={() =>
                decide(
                  selFindings.filter((r) => r.isMessage).map((r) => r.id),
                  'delete',
                )
              }
            >
              Apagar mensagem
            </button>
            <button
              className={buttonClass('ghost', 'sm')}
              disabled={!selFindings.length || pending}
              onClick={() =>
                decide(
                  selFindings.map((r) => r.id),
                  'ignore',
                )
              }
            >
              Ignorar achados
            </button>
          </span>
        )}
        {msg && (
          <span role="status" className="text-sm font-medium text-fg">
            {msg}
          </span>
        )}
      </div>
      <Table stack data-testid="incidents-table">
        <thead>
          <tr>
            <Th className="w-10">
              <span className="sr-only">Selecionar</span>
            </Th>
            <Th>Data</Th>
            <Th>Tipo</Th>
            <Th>Participante</Th>
            <Th>Operação / grupo</Th>
            <Th>Ação tomada</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="align-top">
              <Td>
                <input
                  type="checkbox"
                  className={checkboxClass}
                  aria-label={`selecionar incidente ${r.who}`}
                  checked={sel.has(r.id)}
                  onChange={() => toggle(r.id)}
                />
              </Td>
              <Td className="whitespace-nowrap tabular-nums">{r.createdAt}</Td>
              <Td>
                <Badge tone={sevTone[r.severity] ?? 'neutral'}>{r.kindLabel}</Badge>
                {r.reason && <p className="mt-1 text-xs text-muted">{r.reason}</p>}
                {r.detail && (
                  <p className="mt-1 max-w-xs truncate text-xs text-muted" title={r.detail}>
                    {r.detail}
                  </p>
                )}
              </Td>
              <Td className="whitespace-nowrap font-mono text-xs">
                {r.who}
                {r.actor && r.actor !== r.who && <p className="text-muted">por {r.actor}</p>}
              </Td>
              <Td>
                {r.campaign ?? '—'}
                {r.group && <p className="text-xs text-muted">{r.group}</p>}
              </Td>
              <Td className="text-xs">
                {r.actions.length
                  ? r.actions.map((a, i) => (
                      <span key={i} className={a.ok ? 'text-fg' : 'font-medium text-bad'} title={a.error}>
                        {a.type}
                        {a.ok ? ' ✓' : ' ✗'}
                        {i < r.actions.length - 1 ? ', ' : ''}
                      </span>
                    ))
                  : '—'}
              </Td>
              <Td className="text-xs">
                <Badge tone={r.resolved ? 'off' : (STATUS_TONE[r.status] ?? 'neutral')}>
                  {r.statusLabel}
                </Badge>
                {r.resolved && <p className="mt-1 text-muted">resolvido</p>}
                {r.finding && !r.resolved && (
                  <span className="mt-1.5 flex flex-wrap gap-1" data-testid="finding-actions">
                    <button
                      className={`${linkBtn} !text-bad hover:!bg-bad-soft`}
                      disabled={pending}
                      aria-label={`remover ${r.who}`}
                      onClick={() => decide([r.id], 'remove')}
                    >
                      Remover
                    </button>
                    <button
                      className={`${linkBtn} !text-bad hover:!bg-bad-soft`}
                      disabled={pending}
                      aria-label={`remover e bloquear ${r.who}`}
                      onClick={() => decide([r.id], 'remove', true)}
                    >
                      Remover e bloquear
                    </button>
                    {r.isMessage && (
                      <button
                        className={`${linkBtn} !text-bad hover:!bg-bad-soft`}
                        disabled={pending}
                        aria-label={`apagar mensagem de ${r.who}`}
                        onClick={() => decide([r.id], 'delete')}
                      >
                        Apagar
                      </button>
                    )}
                    <button
                      className={linkBtn}
                      disabled={pending}
                      aria-label={`ignorar ${r.who}`}
                      onClick={() => decide([r.id], 'ignore')}
                    >
                      Ignorar
                    </button>
                  </span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

/** Baixa o CSV dos incidentes filtrados (até 500). */
export function ExportButton({ filter }: { filter: Record<string, string> }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button
        className={buttonClass('secondary', 'sm')}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await exportIncidentsAction(filter);
            if (!r.ok) return setErr(r.error);
            const url = URL.createObjectURL(new Blob([r.data], { type: 'text/csv;charset=utf-8' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `incidentes-seguranca-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            URL.revokeObjectURL(url);
          })
        }
      >
        Exportar CSV
      </button>
      {err && <span className="text-sm font-medium text-bad">{err}</span>}
    </>
  );
}

/** Opt-in de uma operação no anti-spam compartilhado. */
export function OptInToggle({
  campaignId,
  name,
  enabled,
}: {
  campaignId: string;
  name: string;
  enabled: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = useState(enabled);
  const [pending, start] = useTransition();
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 px-1 py-2 text-sm hover:bg-subtle">
      <span className="truncate text-fg">{name}</span>
      <input
        type="checkbox"
        role="switch"
        className={checkboxClass}
        aria-label={`anti-spam compartilhado em ${name}`}
        checked={on}
        disabled={pending}
        onChange={(e) => {
          const v = e.target.checked;
          setOn(v);
          start(async () => {
            const r = await antiSpamOptInAction(campaignId, v);
            if (!r.ok) setOn(!v);
            else router.refresh();
          });
        }}
      />
    </label>
  );
}
