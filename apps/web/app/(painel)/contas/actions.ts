'use server';

import { AccountNotFoundError } from '@mag/accounts';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth';
import { accountsService, NO_ENGINE_MESSAGE } from '@/server/services/accounts';

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Início do erro que `remove()` lança em português quando o WhatsApp não encerrou a sessão (texto pronto para o operador). */
const REMOVE_FAILED = 'Não foi possível encerrar a sessão no WhatsApp';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(fn: () => Promise<void>): Promise<ActionResult> {
  await requireAdmin(); // fora do try: o redirecionamento para /login não pode ser engolido
  try {
    await fn();
    revalidatePath('/contas');
    return { ok: true };
  } catch (e) {
    if (e instanceof AccountNotFoundError) return { ok: false, error: 'Conta não encontrada.' };
    if (e instanceof Error && (e.message === NO_ENGINE_MESSAGE || e.message.startsWith(REMOVE_FAILED))) return { ok: false, error: e.message };
    console.error('[contas]', e);
    return { ok: false, error: 'Não foi possível concluir. Tente de novo.' };
  }
}

export async function criarContaAction(name: string): Promise<ActionResult> {
  await requireAdmin();
  const nome = typeof name === 'string' ? name.trim() : '';
  if (!nome || nome.length > 80) return { ok: false, error: 'Informe o nome da conta (até 80 caracteres).' };
  return run(async () => {
    await (await accountsService()).create({ name: nome });
  });
}

export async function conectarContaAction(id: string): Promise<ActionResult> {
  return run(async () => {
    if (!UUID.test(id)) throw new AccountNotFoundError(String(id));
    await (await accountsService()).connect(id);
  });
}

export async function papelContaAction(id: string, role: 'normal' | 'spy'): Promise<ActionResult> {
  return run(async () => {
    if (!UUID.test(id)) throw new AccountNotFoundError(String(id));
    if (role !== 'normal' && role !== 'spy') throw new Error('papel inválido');
    await (await accountsService()).setRole(id, role);
  });
}

export async function removerContaAction(id: string): Promise<ActionResult> {
  return run(async () => {
    if (!UUID.test(id)) throw new AccountNotFoundError(String(id));
    await (await accountsService()).remove(id);
  });
}
