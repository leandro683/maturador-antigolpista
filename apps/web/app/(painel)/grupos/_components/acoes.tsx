'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  arquivarOperacaoAction,
  buscarGruposAction,
  criarOperacaoAction,
  definirChipsAction,
  importarGruposAction,
  removerGrupoAction,
  renomearOperacaoAction,
  type Result,
} from '../actions';
import { Badge } from '@/components/ui/badge';
import { buttonClass } from '@/components/ui/button';
import { confirmar } from '@/components/ui/confirm';
import { checkboxClass, inputClass } from '@/components/ui/form';
import { toast } from '@/components/ui/toast';

type RemoteGroup = { gid: string; name: string; participants: number; monitored: 'esta' | 'outra' | null };

function useAcao() {
  const router = useRouter();
  const [pending, start] = useTransition();
  /** Roda a ação; erro vira aviso vermelho, sucesso atualiza a tela. Devolve true se deu certo. */
  const rodar = async <T,>(fn: () => Promise<Result<T>>, ok?: (d: T) => string | undefined) => {
    const r = await fn();
    if (r.ok) {
      const msg = ok?.(r.data);
      if (msg) toast(msg);
      router.refresh();
    } else toast(r.error, 'bad');
    return r.ok;
  };
  return { pending, start, rodar, router };
}

export function CriarOperacao() {
  const { pending, start, router } = useAcao();
  const [nome, setNome] = useState('');
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await criarOperacaoAction(nome);
          if (r.ok) router.push(`/grupos/${r.data}`);
          else toast(r.error, 'bad');
        });
      }}
    >
      <label className="block text-sm">
        <span className="mb-1.5 block text-[13px] font-medium text-muted">Nome da nova operação</span>
        <input
          className={`${inputClass} w-64`}
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          maxLength={80}
          required
          placeholder="Ex.: Lançamento de março"
        />
      </label>
      <button type="submit" className={buttonClass('primary')} disabled={pending}>
        Criar operação
      </button>
    </form>
  );
}

export function ArquivarBotao({ id, nome, arquivada }: { id: string; nome: string; arquivada: boolean }) {
  const { pending, start, rodar } = useAcao();
  return (
    <button
      type="button"
      className={buttonClass('secondary', 'sm')}
      disabled={pending}
      onClick={() =>
        start(async () => {
          if (!arquivada) {
            const ok = await confirmar({
              title: `Arquivar “${nome}”?`,
              message: 'A operação sai da lista. Dá para restaurar em “Arquivadas”.',
              confirmLabel: 'Arquivar',
            });
            if (!ok) return;
          }
          await rodar(() => arquivarOperacaoAction(id, !arquivada), () => (arquivada ? 'Operação restaurada.' : 'Operação arquivada.'));
        })
      }
    >
      {arquivada ? 'Restaurar' : 'Arquivar'}
    </button>
  );
}

export function RenomearForm({ id, nome: atual }: { id: string; nome: string }) {
  const { pending, start, rodar } = useAcao();
  const [nome, setNome] = useState(atual);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          await rodar(() => renomearOperacaoAction(id, nome), () => 'Nome salvo.');
        });
      }}
    >
      <label className="block text-sm">
        <span className="mb-1.5 block text-[13px] font-medium text-muted">Nome da operação</span>
        <input className={`${inputClass} w-72`} value={nome} onChange={(e) => setNome(e.target.value)} maxLength={80} required />
      </label>
      <button type="submit" className={buttonClass('secondary')} disabled={pending || nome.trim() === atual}>
        Salvar nome
      </button>
    </form>
  );
}

export function ChipsForm({
  id,
  contas,
  marcadas,
}: {
  id: string;
  contas: { id: string; name: string }[];
  marcadas: string[];
}) {
  const { pending, start, rodar } = useAcao();
  const [sel, setSel] = useState(new Set(marcadas));
  if (!contas.length) return <p className="text-sm text-muted">Nenhuma conta criada ainda. Crie e conecte chips em Contas.</p>;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          await rodar(() => definirChipsAction(id, [...sel]), () => 'Chips da operação salvos.');
        });
      }}
    >
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {contas.map((c) => (
          <li key={c.id}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className={checkboxClass}
                checked={sel.has(c.id)}
                onChange={(e) => {
                  const n = new Set(sel);
                  if (e.target.checked) n.add(c.id);
                  else n.delete(c.id);
                  setSel(n);
                }}
              />
              {c.name}
            </label>
          </li>
        ))}
      </ul>
      <button type="submit" className={buttonClass('primary')} disabled={pending}>
        Salvar chips
      </button>
    </form>
  );
}

export function BuscarGrupos({ id, chips }: { id: string; chips: { id: string; name: string }[] }) {
  const { pending, start, rodar } = useAcao();
  const [escolhido, setChip] = useState('');
  // derivado: os chips podem chegar depois (salvar chips na mesma tela) e o valor inicial do useState ficaria vazio
  const chip = chips.some((c) => c.id === escolhido) ? escolhido : (chips[0]?.id ?? '');
  const [lista, setLista] = useState<RemoteGroup[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());

  if (!chips.length)
    return <p className="text-sm text-muted">Escolha pelo menos um chip da operação (acima) para buscar os grupos dele.</p>;

  const buscar = () =>
    start(async () => {
      const r = await buscarGruposAction(id, chip);
      if (!r.ok) return toast(r.error, 'bad');
      setLista(r.data);
      setSel(new Set()); // os já monitorados aparecem marcados e travados; só os novos entram na seleção
    });

  const monitorar = () =>
    start(async () => {
      const novos = [...sel];
      await rodar(
        () => importarGruposAction(id, chip, novos),
        (d) =>
          `${d.imported} novo(s), ${d.updated} atualizado(s)` +
          (d.skipped ? `, ${d.skipped} já em outra operação` : '') +
          (d.failed ? `, ${d.failed} com falha` : '') +
          '.',
      );
      setLista(null);
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block text-sm">
          <span className="mb-1.5 block text-[13px] font-medium text-muted">Chip</span>
          <select
            className={`${inputClass} w-64`}
            value={chip}
            onChange={(e) => {
              // a lista veio de outro chip: importar com este misturaria grupos e chip
              setChip(e.target.value);
              setLista(null);
              setSel(new Set());
            }}
          >
            {chips.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={buttonClass('secondary')} onClick={buscar} disabled={pending || !chip}>
          {pending && !lista ? 'Buscando…' : 'Buscar grupos do WhatsApp'}
        </button>
      </div>

      {lista && (
        <div className="space-y-3">
          {lista.length === 0 ? (
            <p className="text-sm text-muted">Esse chip não está em nenhum grupo.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-border overflow-y-auto rounded-md border border-border text-sm">
              {lista.map((g) => (
                <li key={g.gid} className="flex items-center gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    className={checkboxClass}
                    aria-label={`Monitorar ${g.name}`}
                    disabled={g.monitored !== null}
                    checked={g.monitored === 'esta' || sel.has(g.gid)}
                    onChange={(e) => {
                      const n = new Set(sel);
                      if (e.target.checked) n.add(g.gid);
                      else n.delete(g.gid);
                      setSel(n);
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate">{g.name}</span>
                  <span className="tabular-nums text-muted">{g.participants} membros</span>
                  {g.monitored === 'esta' && <Badge tone="ok">monitorado</Badge>}
                  {g.monitored === 'outra' && <Badge tone="warn">em outra operação</Badge>}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className={buttonClass('primary')} onClick={monitorar} disabled={pending || sel.size === 0}>
            {pending ? 'Salvando…' : `Monitorar selecionados (${sel.size})`}
          </button>
        </div>
      )}
    </div>
  );
}

export function RemoverGrupo({ operacaoId, id, nome }: { operacaoId: string; id: string; nome: string }) {
  const { pending, start, rodar } = useAcao();
  return (
    <button
      type="button"
      className={buttonClass('danger', 'sm')}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const ok = await confirmar({
            title: `Parar de monitorar “${nome}”?`,
            message: 'O grupo e a lista de participantes salva aqui saem do painel. O grupo no WhatsApp não é mexido.',
            confirmLabel: 'Remover',
            tone: 'danger',
          });
          if (ok) await rodar(() => removerGrupoAction(operacaoId, id), () => 'Grupo removido.');
        })
      }
    >
      Remover
    </button>
  );
}
