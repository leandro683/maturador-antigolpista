/**
 * Monta o registro de audit log. Gravação fica com o chamador
 * (route handler / service) dentro da mesma transação da mutação.
 */
export const HISTORY_RETENTION_DAYS = 60;

export type HistoryInput = {
  location: string; // módulo/tela, ex. 'campanhas'
  type: string; // ação, ex. 'campaign.update'
  entityIds: string[];
  before?: unknown;
  after?: unknown;
  memberId?: string | null;
  ip?: string | null;
  now?: Date;
};

export function buildHistoryRow(input: HistoryInput) {
  if (!input.location || !input.type) throw new Error('history: location e type obrigatórios');
  if (input.entityIds.length === 0) throw new Error('history: entityIds vazio');
  const now = input.now ?? new Date();
  return {
    location: input.location,
    type: input.type,
    entityIds: input.entityIds,
    before: input.before ?? null,
    after: input.after ?? null,
    memberId: input.memberId ?? null,
    ip: input.ip ?? null,
    createdAt: now,
    deleteIn: new Date(now.getTime() + HISTORY_RETENTION_DAYS * 86_400_000),
  };
}
