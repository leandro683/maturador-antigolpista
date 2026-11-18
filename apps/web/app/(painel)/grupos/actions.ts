'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth';
import {
  GruposError,
  gruposService,
  type ImportResult,
  type RemoteGroup,
} from '@/server/services/grupos';

export type Result<T = null> = { ok: true; data: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run<T>(fn: () => Promise<T>, paths: string[] = []): Promise<Result<T>> {
  await requireAdmin(); // fora do try: o redirecionamento para /login não pode ser engolido
  try {
    const data = await fn();
    revalidatePath('/grupos');
    for (const p of paths) revalidatePath(p);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof GruposError) return { ok: false, error: e.message };
    console.error('[grupos]', e);
    return { ok: false, error: 'Não foi possível concluir. Confira se o chip está conectado e tente de novo.' };
  }
}

const uuid = (s: unknown): string => {
  if (typeof s !== 'string' || !UUID.test(s)) throw new GruposError('Identificador inválido.');
  return s;
};

export const criarOperacaoAction = async (name: string) =>
  run(async () => (await (await gruposService()).criar(name)).id);

export const renomearOperacaoAction = async (id: string, name: string) =>
  run(async () => (await gruposService()).renomear(uuid(id), name).then(() => null), [`/grupos/${id}`]);

export const arquivarOperacaoAction = async (id: string, archived: boolean) =>
  run(async () => (await gruposService()).arquivar(uuid(id), Boolean(archived)).then(() => null));

export const definirChipsAction = async (id: string, accountIds: string[]) =>
  run(async () => {
    if (!Array.isArray(accountIds)) throw new GruposError('Lista de chips inválida.');
    await (await gruposService()).definirChips(uuid(id), accountIds.map(uuid));
    return null;
  }, [`/grupos/${id}`]);

export const buscarGruposAction = async (operacaoId: string, accountId: string): Promise<Result<RemoteGroup[]>> =>
  run(async () => (await gruposService()).buscarGrupos(uuid(operacaoId), uuid(accountId)));

export const importarGruposAction = async (
  operacaoId: string,
  accountId: string,
  gids: string[],
): Promise<Result<ImportResult>> =>
  run(async () => {
    if (!Array.isArray(gids) || gids.some((g) => typeof g !== 'string')) throw new GruposError('Lista de grupos inválida.');
    return (await gruposService()).importar(uuid(operacaoId), uuid(accountId), gids);
  }, [`/grupos/${operacaoId}`]);

export const removerGrupoAction = async (operacaoId: string, groupId: string) =>
  run(async () => (await gruposService()).removerGrupo(uuid(groupId)).then(() => null), [`/grupos/${operacaoId}`]);
