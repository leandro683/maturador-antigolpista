import { gruposService } from '@/server/services/grupos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Operação pelo id da rota (null se o id não é um UUID ou não existe). Exige sessão de admin. */
export async function operacaoOuNull(id: string) {
  const svc = await gruposService();
  return UUID.test(id) ? svc.get(id) : null;
}
