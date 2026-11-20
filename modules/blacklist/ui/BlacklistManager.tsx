'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { nativeAsk, type ActionResult, type Ask } from '../action-result';
import { parseBlockCsv, type CsvEntry, type CsvResult } from '../csv';

/** Números bloqueados: listas nomeadas, adicionar manual/CSV, busca, remover + números administrativos. */

export type BlListItem = { id: string; name: string; count: number; disabled: boolean };
export type BlNumberItem = {
  id: string;
  number: string | null;
  lid: string | null;
  name: string | null;
  source: string;
  createdAt: string;
};
export type BlAdminItem = { id: string; number: string; label: string | null };

export type BlacklistActions = {
  /** diálogo de confirmação do painel (default: window.confirm) */
  ask?: Ask;
  createList: (name: string) => Promise<ActionResult<{ id: string }>>;
  toggleList: (id: string, disabled: boolean) => Promise<ActionResult<null>>;
  deleteList: (id: string) => Promise<ActionResult<null>>;
  addNumber: (
    listId: string,
    value: string,
    kind: 'phone' | 'lid',
    name: string,
  ) => Promise<ActionResult<null>>;
  importCsv: (
    listId: string,
    entries: CsvEntry[],
  ) => Promise<ActionResult<{ inserted: number; skipped: number }>>;
  removeNumbers: (ids: string[]) => Promise<ActionResult<null>>;
  addAdmin: (value: string, label: string) => Promise<ActionResult<null>>;
  removeAdmin: (id: string) => Promise<ActionResult<null>>;
};

const SOURCE: Record<string, string> = {
  manual: 'Manual',
  csv: 'CSV',
  anti_hacker: 'Automático',
  import: 'Importado',
};
/* Visual = apps/web/src/components/ui (inputClass, buttonClass, Table, Pager) — módulos não importam de apps/web. */
const input =
  'rounded-md border border-border-strong bg-card px-3 py-1.5 text-sm text-fg shadow-xs outline-none transition-colors placeholder:text-muted hover:border-muted/70 focus:border-accent focus:ring-2 focus:ring-accent/25';
const btn =
  'inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-border-strong bg-card px-3 text-sm font-medium text-fg shadow-xs transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50';
const danger =
  'inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-bad/40 bg-card px-3 text-sm font-medium text-bad transition-colors hover:bg-bad-soft disabled:cursor-not-allowed disabled:opacity-50';
const primary =
  'inline-flex h-8 items-center justify-center whitespace-nowrap rounded-md bg-accent px-3.5 text-sm font-medium text-accent-fg shadow-xs transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50';
const card = 'rounded-xl border border-border bg-card shadow-card';
const check = 'size-4 accent-[var(--color-accent)]';
const nf = new Intl.NumberFormat('pt-BR');
const dt = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
});
const sideLink = (active: boolean) =>
  `rounded-md px-2 py-1.5 transition-colors ${active ? 'bg-accent-soft font-medium text-accent' : 'text-fg hover:bg-subtle'}`;

export function BlacklistManager({
  tab,
  lists,
  listId,
  numbers,
  total,
  page,
  pageSize,
  q,
  admins,
  actions,
}: {
  tab: 'bloqueados' | 'admin';
  lists: BlListItem[];
  listId: string | null;
  numbers: BlNumberItem[];
  total: number;
  page: number;
  pageSize: number;
  q: string;
  admins: BlAdminItem[];
  actions: BlacklistActions;
}) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const run = <T,>(p: Promise<ActionResult<T>>, okText: (d: T) => string) =>
    start(async () => {
      const r = await p;
      setMsg(r.ok ? { ok: true, text: okText(r.data) } : { ok: false, text: r.error });
    });

  const href = (p: Record<string, string | number | null>) => {
    const u = new URLSearchParams();
    const all = { aba: tab === 'admin' ? 'admin' : null, lista: listId, q: q || null, pagina: null, ...p };
    for (const [k, v] of Object.entries(all))
      if (v !== null && v !== '' && v !== undefined) u.set(k, String(v));
    return `/bloqueados?${u.toString()}`;
  };

  return (
    <div className="space-y-4">
      <nav
        className="-mx-1 flex gap-0.5 overflow-x-auto border-b border-border px-1 text-sm"
        aria-label="Abas"
      >
        {(
          [
            ['bloqueados', 'Números bloqueados'],
            ['admin', 'Números administrativos'],
          ] as const
        ).map(([k, l]) => (
          <a
            key={k}
            href={k === 'admin' ? '/bloqueados?aba=admin' : '/bloqueados'}
            aria-current={tab === k ? 'page' : undefined}
            className={`-mb-px whitespace-nowrap rounded-t-md border-b-2 px-3 py-2.5 transition-colors ${tab === k ? 'border-accent font-semibold text-fg' : 'border-transparent text-muted hover:border-border-strong hover:text-fg'}`}
          >
            {l}
          </a>
        ))}
      </nav>
      {msg && (
        <p
          role="status"
          className={`rounded-lg border px-4 py-2.5 text-sm font-medium ${msg.ok ? 'border-ok/30 bg-ok-soft text-ok' : 'border-bad/30 bg-bad-soft text-bad'}`}
        >
          {msg.text}
        </p>
      )}
      {tab === 'admin' ? (
        <AdminTab admins={admins} actions={actions} run={run} pending={pending} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
          <ListsSidebar lists={lists} listId={listId} actions={actions} run={run} href={href} />
          <NumbersPanel
            list={lists.find((l) => l.id === listId) ?? null}
            numbers={numbers}
            total={total}
            page={page}
            pageSize={pageSize}
            q={q}
            href={href}
            actions={actions}
            run={run}
            pending={pending}
          />
        </div>
      )}
    </div>
  );
}

type Run = <T>(p: Promise<ActionResult<T>>, okText: (d: T) => string) => void;
type Href = (p: Record<string, string | number | null>) => string;

function ListsSidebar({
  lists,
  listId,
  actions,
  run,
  href,
}: {
  lists: BlListItem[];
  listId: string | null;
  actions: BlacklistActions;
  run: Run;
  href: Href;
}) {
  const [name, setName] = useState('');
  return (
    <aside className={`h-fit space-y-3 p-3 ${card}`}>
      <p className="px-2 text-xs font-semibold text-muted">Listas</p>
      <ul className="space-y-0.5 text-sm">
        <li>
          <a href={href({ lista: null })} className={`block ${sideLink(!listId)}`}>
            Todas as listas
          </a>
        </li>
        {lists.map((l) => (
          <li key={l.id}>
            <a
              href={href({ lista: l.id, q: null })}
              className={`flex items-center gap-2 ${sideLink(listId === l.id)}`}
            >
              <span className={`flex-1 truncate ${l.disabled ? 'text-muted line-through' : ''}`}>
                {l.name}
              </span>
              <span className="text-xs tabular-nums text-muted">{nf.format(l.count)}</span>
            </a>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          run(actions.createList(name.trim()), () => 'Lista criada.');
          setName('');
        }}
      >
        <input
          aria-label="Nova lista"
          placeholder="Nova lista"
          className={`${input} w-full min-w-0`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className={btn} aria-label="Criar lista">
          +
        </button>
      </form>
    </aside>
  );
}

function NumbersPanel({
  list,
  numbers,
  total,
  page,
  pageSize,
  q,
  href,
  actions,
  run,
  pending,
}: {
  list: BlListItem | null;
  numbers: BlNumberItem[];
  total: number;
  page: number;
  pageSize: number;
  q: string;
  href: Href;
  actions: BlacklistActions;
  run: Run;
  pending: boolean;
}) {
  const [sel, setSel] = useState<string[]>([]);
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<'phone' | 'lid'>('phone');
  const [name, setName] = useState('');
  const [csv, setCsv] = useState<CsvResult | null>(null);
  const pages = Math.max(1, Math.ceil(total / pageSize));

  function add(e: FormEvent) {
    e.preventDefault();
    if (!list) return;
    run(actions.addNumber(list.id, value, kind, name), () => 'Número bloqueado.');
    setValue('');
    setName('');
  }

  return (
    <section className="min-w-0 space-y-4">
      {list ? (
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-fg">{list.name}</h2>
          {list.disabled ? (
            <span className="rounded-full bg-subtle px-2 py-0.5 text-xs font-medium text-muted ring-1 ring-inset ring-border">
              Desativada
            </span>
          ) : (
            <span className="rounded-full bg-ok-soft px-2 py-0.5 text-xs font-medium text-ok ring-1 ring-inset ring-ok/25">
              Ativa
            </span>
          )}
          <div className="ml-auto flex gap-2">
            <button
              className={btn}
              onClick={() =>
                run(actions.toggleList(list.id, !list.disabled), () =>
                  list.disabled ? 'Lista ativada.' : 'Lista desativada.',
                )
              }
            >
              {list.disabled ? 'Ativar' : 'Desativar'}
            </button>
            <button
              className={danger}
              onClick={async () =>
                (await (actions.ask ?? nativeAsk)({
                  title: `Excluir a lista "${list.name}"?`,
                  message: `Os ${list.count} números dela deixam de ser bloqueados.`,
                  confirmLabel: 'Excluir lista',
                  tone: 'danger',
                })) && run(actions.deleteList(list.id), () => 'Lista excluída.')
              }
            >
              Excluir lista
            </button>
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-info/30 bg-info-soft px-4 py-2.5 text-sm text-info">
          Selecione uma lista para adicionar números. A busca abaixo cobre todas as listas.
        </p>
      )}

      {list && (
        <div className="grid gap-3 xl:grid-cols-2">
          <form onSubmit={add} className={`space-y-3 p-4 ${card}`}>
            <p className="text-sm font-semibold text-fg">Adicionar número</p>
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="Tipo de número"
                className={input}
                value={kind}
                onChange={(e) => setKind(e.target.value as 'phone' | 'lid')}
              >
                <option value="phone">Telefone</option>
                <option value="lid">LID</option>
              </select>
              <input
                aria-label="Número a bloquear"
                placeholder={kind === 'phone' ? '(11) 99999-0000' : '123456789012345'}
                className={`${input} min-w-40 flex-1`}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <input
                aria-label="Nome (opcional)"
                placeholder="Nome (opcional)"
                className={`${input} flex-1`}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <button type="submit" className={primary} disabled={pending || !value.trim()}>
                Bloquear
              </button>
            </div>
          </form>
          <div className={`space-y-3 p-4 ${card}`}>
            <p className="text-sm font-semibold text-fg">Importar CSV</p>
            <p className="text-xs text-muted">
              Colunas: “telefone” e/ou “lid” (+ “nome” opcional). Separador vírgula ou ponto e vírgula.
            </p>
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              aria-label="Arquivo CSV"
              className="block w-full text-sm text-fg file:mr-3 file:rounded-md file:border file:border-border-strong file:bg-card file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-fg hover:file:bg-subtle"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                setCsv(f ? parseBlockCsv(await f.text()) : null);
              }}
            />
            {csv && (
              <div className="space-y-1.5 rounded-lg bg-subtle p-3 text-sm" data-testid="csv-summary">
                <p className="font-medium text-fg">
                  {csv.entries.length} válido(s)
                  {csv.duplicates ? ` · ${csv.duplicates} repetido(s)` : ''}
                  {csv.errors.length ? ` · ${csv.errors.length} com erro` : ''}
                </p>
                {csv.errors.slice(0, 5).map((er) => (
                  <p key={er.line} className="text-xs font-medium text-bad">
                    Linha {er.line}: {er.value} — {er.reason}
                  </p>
                ))}
                <button
                  type="button"
                  className={primary}
                  disabled={pending || csv.entries.length === 0}
                  onClick={() => {
                    run(
                      actions.importCsv(list.id, csv.entries),
                      (d) => `${d.inserted} importado(s), ${d.skipped} já existia(m).`,
                    );
                    setCsv(null);
                  }}
                >
                  Importar {csv.entries.length}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <form className="flex flex-wrap items-center gap-2" action="/bloqueados">
        {list && <input type="hidden" name="lista" value={list.id} />}
        <input
          name="q"
          defaultValue={q}
          aria-label="Buscar número ou nome"
          placeholder="Buscar número ou nome"
          className={`${input} min-w-48 flex-1`}
        />
        <button className={btn} type="submit">
          Buscar
        </button>
        {sel.length > 0 && (
          <button
            type="button"
            className={danger}
            onClick={async () => {
              const ok = await (actions.ask ?? nativeAsk)({
                title: `Remover ${sel.length} número(s) da lista?`,
                message: 'Eles deixam de ser bloqueados.',
                confirmLabel: 'Remover',
                tone: 'danger',
              });
              if (!ok) return;
              run(actions.removeNumbers(sel), () => `${sel.length} número(s) removido(s).`);
              setSel([]);
            }}
          >
            Remover {sel.length}
          </button>
        )}
      </form>

      {numbers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-strong bg-card/60 px-4 py-8 text-center">
          <p className="text-sm font-medium text-fg">Nenhum número bloqueado.</p>
          <p className="mt-1 text-sm text-muted">
            {q
              ? 'Nada encontrado com essa busca.'
              : list
                ? 'Adicione um número ou importe um CSV acima.'
                : 'Escolha uma lista à esquerda (ou crie uma) para adicionar números.'}
          </p>
        </div>
      ) : (
        <div className="mag-table-wrap overflow-x-auto rounded-xl border border-border bg-card shadow-card">
          <table className="mag-table w-full text-sm" data-testid="blocked-table">
            <thead>
              <tr>
                <th scope="col" className="w-10">
                  <span className="sr-only">Selecionar</span>
                </th>
                <th scope="col" className="text-left">
                  Nome
                </th>
                <th scope="col" className="text-left">
                  Número / LID
                </th>
                <th scope="col" className="text-left">
                  Origem
                </th>
                <th scope="col" className="text-left">
                  Criado em
                </th>
              </tr>
            </thead>
            <tbody>
              {numbers.map((n) => (
                <tr key={n.id}>
                  <td>
                    <input
                      type="checkbox"
                      className={check}
                      aria-label={`Selecionar ${n.number ?? n.lid}`}
                      checked={sel.includes(n.id)}
                      onChange={() =>
                        setSel((s) => (s.includes(n.id) ? s.filter((x) => x !== n.id) : [...s, n.id]))
                      }
                    />
                  </td>
                  <td>{n.name ?? <span className="text-muted">—</span>}</td>
                  <td className="whitespace-nowrap font-mono text-xs">{n.number ?? `${n.lid}@lid`}</td>
                  <td>
                    <span className="rounded-full bg-subtle px-2 py-0.5 text-xs font-medium text-fg ring-1 ring-inset ring-border-strong/60">
                      {SOURCE[n.source] ?? n.source}
                    </span>
                  </td>
                  <td className="whitespace-nowrap text-xs tabular-nums text-muted">
                    {dt.format(new Date(n.createdAt))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <nav aria-label="Paginação" className="flex flex-wrap items-center gap-2 text-sm">
          <a
            aria-disabled={page <= 1}
            className={`${btn} ${page <= 1 ? 'pointer-events-none opacity-40' : ''}`}
            href={href({ pagina: page - 1 })}
          >
            Anterior
          </a>
          <span className="tabular-nums text-muted">
            {nf.format((page - 1) * pageSize + 1)}-{nf.format(Math.min(page * pageSize, total))} de{' '}
            {nf.format(total)}
          </span>
          <a
            aria-disabled={page >= pages}
            className={`${btn} ${page >= pages ? 'pointer-events-none opacity-40' : ''}`}
            href={href({ pagina: page + 1 })}
          >
            Próxima
          </a>
        </nav>
      )}
    </section>
  );
}

function AdminTab({
  admins,
  actions,
  run,
  pending,
}: {
  admins: BlAdminItem[];
  actions: BlacklistActions;
  run: Run;
  pending: boolean;
}) {
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted">
        Números da equipe e administradores: nunca são bloqueados nem removidos pelo anti-spam, mesmo se
        estiverem em alguma lista.
      </p>
      <form
        className={`flex flex-wrap gap-2 p-4 ${card}`}
        onSubmit={(e) => {
          e.preventDefault();
          run(actions.addAdmin(value, label), () => 'Número administrativo adicionado.');
          setValue('');
          setLabel('');
        }}
      >
        <input
          aria-label="Número administrativo"
          placeholder="(11) 99999-0000"
          className={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <input
          aria-label="Identificação"
          placeholder="Identificação (ex.: Suporte)"
          className={input}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button className={primary} disabled={pending || !value.trim()} type="submit">
          Adicionar
        </button>
      </form>
      {admins.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-strong bg-card/60 px-4 py-8 text-center">
          <p className="text-sm font-medium text-fg">Nenhum número administrativo.</p>
          <p className="mt-1 text-sm text-muted">Adicione os números da equipe no formulário acima.</p>
        </div>
      ) : (
        <ul className={`divide-y divide-border overflow-hidden ${card}`} data-testid="admin-list">
          {admins.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-subtle">
              <span className="font-medium text-fg">{a.label ?? '—'}</span>
              <span className="font-mono text-xs text-muted">{a.number}</span>
              <button
                type="button"
                className="ml-auto rounded-md px-2 py-1 text-xs font-medium text-bad hover:bg-bad-soft"
                onClick={() => run(actions.removeAdmin(a.id), () => 'Removido.')}
              >
                Remover
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
