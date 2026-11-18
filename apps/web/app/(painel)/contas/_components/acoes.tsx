'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { criarContaAction, papelContaAction, removerContaAction, type ActionResult } from '../actions';
import { buttonClass } from '@/components/ui/button';
import { confirmar } from '@/components/ui/confirm';
import { inputClass } from '@/components/ui/form';
import { toast } from '@/components/ui/toast';

function useAcao() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const rodar = (fn: () => Promise<ActionResult>, ok?: string) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        if (ok) toast(ok);
        router.refresh();
      } else toast(r.error, 'bad');
    });
  return { pending, rodar, router };
}

export function CriarConta() {
  const { pending, rodar } = useAcao();
  const [nome, setNome] = useState('');
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        rodar(async () => {
          const r = await criarContaAction(nome);
          if (r.ok) setNome('');
          return r;
        }, 'Conta criada.');
      }}
    >
      <label className="block text-sm">
        <span className="mb-1.5 block text-[13px] font-medium text-muted">Nome da nova conta</span>
        <input
          className={`${inputClass} w-64`}
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          maxLength={80}
          required
          placeholder="Ex.: Chip 01"
        />
      </label>
      <button type="submit" className={buttonClass('primary')} disabled={pending}>
        Criar conta
      </button>
    </form>
  );
}

export function Atualizar() {
  const { pending, router } = useAcao();
  return (
    <button type="button" className={buttonClass('secondary')} disabled={pending} onClick={() => router.refresh()}>
      Atualizar
    </button>
  );
}

export function AcoesConta({ id, nome, espia }: { id: string; nome: string; espia: boolean }) {
  const { pending, rodar } = useAcao();
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Link href={`/contas/${id}/conectar`} className={buttonClass('secondary', 'sm')}>
        Conectar
      </Link>
      <button
        type="button"
        className={buttonClass('secondary', 'sm')}
        disabled={pending}
        onClick={() => rodar(() => papelContaAction(id, espia ? 'normal' : 'spy'), espia ? 'Conta normal.' : 'Conta espiã.')}
      >
        {espia ? 'Tirar de espiã' : 'Marcar como espiã'}
      </button>
      <button
        type="button"
        className={buttonClass('danger', 'sm')}
        disabled={pending}
        onClick={async () => {
          const ok = await confirmar({
            title: `Remover a conta “${nome}”?`,
            message: 'A sessão é encerrada no WhatsApp e a conta some do painel. Não dá para desfazer.',
            confirmLabel: 'Remover',
            tone: 'danger',
          });
          if (ok) rodar(() => removerContaAction(id), 'Conta removida.');
        }}
      >
        Remover
      </button>
    </div>
  );
}
