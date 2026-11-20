'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { parseBlockCsv } from '@mag/module-blacklist/csv';
import {
  addCollaboratorAction,
  importCollaboratorsAction,
  removeCollaboratorsAction,
  verifyCollaboratorAction,
} from '../actions';
import { buttonClass } from '@/components/ui/button';
import { confirmar } from '@/components/ui/confirm';
import { checkboxClass, inputClass } from '@/components/ui/form';

/** Busca "este número é colaborador?" (grava histórico). */
export function VerifyBox({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ tone: 'ok' | 'no' | 'err'; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await verifyCollaboratorAction(campaignId, q);
          if (!r.ok) setRes({ tone: 'err', text: r.error });
          else if (!r.data.valid) setRes({ tone: 'err', text: 'Número inválido.' });
          else if (r.data.result)
            setRes({
              tone: 'ok',
              text: `É colaborador oficial${r.data.match?.name ? ` — ${r.data.match.name}` : ''}${
                r.data.match?.kind === 'account' ? ' (conta da operação)' : ''
              }.`,
            });
          else setRes({ tone: 'no', text: 'NÃO é colaborador desta operação.' });
          router.refresh();
        });
      }}
    >
      <input
        className={`${inputClass} max-w-xs`}
        placeholder="(11) 99999-0000"
        aria-label="Número para verificar"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <button className={buttonClass('primary', 'sm')} disabled={pending || !q.trim()}>
        Verificar
      </button>
      {res && (
        <span
          role="status"
          className={`text-sm font-medium ${
            res.tone === 'ok' ? 'text-ok' : res.tone === 'no' ? 'text-bad' : 'text-warn'
          }`}
        >
          {res.text}
        </span>
      )}
    </form>
  );
}

type Row = { id: string; number: string | null; lid: string | null; name: string | null; source: string };

/** Lista manual/CSV com adicionar, importar e remover. */
export function CollaboratorsManager({ campaignId, rows }: { campaignId: string; rows: Row[] }) {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'phone' | 'lid'>('phone');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const file = useRef<HTMLInputElement>(null);
  const done = (r: { ok: boolean; error?: string }, okText: string) => {
    setMsg(r.ok ? okText : (r.error ?? 'erro'));
    if (r.ok) router.refresh();
  };

  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await addCollaboratorAction(campaignId, value, name, kind);
            done(r, 'Colaborador adicionado.');
            if (r.ok) {
              setValue('');
              setName('');
            }
          });
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-fg">Nome</span>
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Nome do colaborador"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-fg">{kind === 'phone' ? 'Telefone' : 'LID'}</span>
          <input
            className={inputClass}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Telefone do colaborador"
          />
        </label>
        <select
          className={`${inputClass} w-auto`}
          value={kind}
          onChange={(e) => setKind(e.target.value as 'phone' | 'lid')}
          aria-label="Tipo"
        >
          <option value="phone">Telefone</option>
          <option value="lid">LID</option>
        </select>
        <button className={buttonClass('primary')} disabled={pending || !value.trim()}>
          Novo colaborador
        </button>
        <button type="button" className={buttonClass('secondary')} onClick={() => file.current?.click()}>
          Adicionar CSV
        </button>
        <input
          ref={file}
          type="file"
          accept=".csv,text/csv,text/plain"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const parsed = parseBlockCsv(await f.text());
            start(async () => {
              const r = await importCollaboratorsAction(campaignId, parsed.entries);
              done(
                r,
                r.ok
                  ? `${r.data.inserted} importado(s), ${r.data.skipped + parsed.duplicates} repetido(s), ${parsed.errors.length} inválido(s).`
                  : '',
              );
            });
          }}
        />
      </form>
      {msg && (
        <p role="status" className="text-sm font-medium text-fg">
          {msg}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          className={buttonClass('danger', 'sm')}
          disabled={!sel.size || pending}
          onClick={async () => {
            const ok = await confirmar({
              title: 'Remover colaboradores?',
              message: `${sel.size} colaborador(es) deixam de ser oficiais nesta operação e passam a ser tratados como qualquer participante.`,
              confirmLabel: 'Remover',
              tone: 'danger',
            });
            if (!ok) return;
            start(async () => {
              const r = await removeCollaboratorsAction(campaignId, [...sel]);
              done(r, `${sel.size} removido(s).`);
              if (r.ok) setSel(new Set());
            });
          }}
        >
          Remover selecionados
        </button>
        <span className="text-xs text-muted">{rows.length} colaborador(es)</span>
      </div>
      <ul
        className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card text-sm shadow-card"
        data-testid="collaborators"
      >
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-subtle">
            <input
              type="checkbox"
              className={checkboxClass}
              aria-label={`selecionar ${r.name ?? r.number ?? r.lid}`}
              checked={sel.has(r.id)}
              onChange={() =>
                setSel((s) => {
                  const n = new Set(s);
                  if (n.has(r.id)) n.delete(r.id);
                  else n.add(r.id);
                  return n;
                })
              }
            />
            <span className="flex-1 text-fg">{r.name ?? '—'}</span>
            <span className="font-mono text-xs">{r.number ?? `${r.lid}@lid`}</span>
            <span className="text-xs text-muted">{r.source === 'csv' ? 'CSV' : 'manual'}</span>
          </li>
        ))}
        {!rows.length && (
          <li className="px-4 py-6 text-center text-muted">
            Nenhum colaborador cadastrado. Adicione pelo formulário acima ou envie um CSV.
          </li>
        )}
      </ul>
    </div>
  );
}
