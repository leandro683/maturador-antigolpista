import 'server-only';
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { campaigns, groupParticipants, groups, waAccounts } from '@mag/db/schema';
import { inviteCodeOf } from '@mag/module-security';
import { phoneFromJid } from '@mag/shared';
import type { WaEngine, WaGroup } from '@mag/wa-engine';
import { requireAdmin } from '@/lib/auth';
import { serverDb } from '@/server/db';
import { serverEngine } from '@/server/engine';

/** Erro com texto seguro para mostrar na tela (o resto vira mensagem genérica na action). */
export class GruposError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GruposError';
  }
}

const GID = /^\d+(-\d+)?@g\.us$/;
const MAX_IMPORT = 200;

export type OperacaoRow = typeof campaigns.$inferSelect;
export type RemoteGroup = {
  gid: string;
  name: string;
  participants: number;
  /** já monitorado: nesta operação, em outra, ou ainda não */
  monitored: 'esta' | 'outra' | null;
};
export type ImportResult = { imported: number; updated: number; skipped: number; failed: number };

const nome = (s: unknown) => {
  const n = typeof s === 'string' ? s.trim() : '';
  if (!n || n.length > 80) throw new GruposError('Informe o nome da operação (até 80 caracteres).');
  return n;
};

/**
 * Operações (campanhas), chips e grupos monitorados. Sem autenticação: quem chama usa `gruposService()`,
 * que exige sessão de admin antes. `engine` é null quando o WhatsApp não está configurado.
 */
export function createGruposService(db: Db, engine: WaEngine | null) {
  const must = async (id: string): Promise<OperacaoRow> => {
    const [op] = await db.select().from(campaigns).where(eq(campaigns.id, id));
    if (!op) throw new GruposError('Operação não encontrada.');
    return op;
  };
  const touch = (id: string, patch: Partial<typeof campaigns.$inferInsert>) =>
    db.update(campaigns).set({ ...patch, updatedAt: new Date() }).where(eq(campaigns.id, id));

  /** Sessão do chip, que precisa ser um dos chips da operação. */
  async function sessionOf(op: OperacaoRow, accountId: string): Promise<string> {
    if (!engine) throw new GruposError('WhatsApp não configurado: defina WAHA_URL.');
    if (!op.accountIds.includes(accountId)) throw new GruposError('Esse chip não faz parte da operação.');
    const [a] = await db.select({ sessionName: waAccounts.sessionName }).from(waAccounts).where(eq(waAccounts.id, accountId));
    if (!a) throw new GruposError('Conta não encontrada.');
    return a.sessionName;
  }

  return {
    get: (id: string) => db.select().from(campaigns).where(eq(campaigns.id, id)).then((r) => r[0] ?? null),

    async listar(opts: { arquivadas?: boolean } = {}) {
      const rows = await db
        .select({
          op: campaigns,
          // `campaigns.id` escrito à mão: ${campaigns.id} sai só como "id" numa consulta de uma tabela e a subconsulta o lê como g.id (sempre 0)
          grupos: sql<number>`(select count(*)::int from ${groups} g where g.campaign_id = campaigns.id)`,
        })
        .from(campaigns)
        .where(eq(campaigns.archived, Boolean(opts.arquivadas)))
        .orderBy(asc(campaigns.position), desc(campaigns.createdAt));
      return rows.map((r) => ({ ...r.op, grupos: r.grupos }));
    },

    async criar(name: string): Promise<OperacaoRow> {
      const [op] = await db.insert(campaigns).values({ name: nome(name), slug: `op-${randomBytes(5).toString('hex')}` }).returning();
      return op!;
    },

    async renomear(id: string, name: string) {
      await must(id);
      await touch(id, { name: nome(name) });
    },

    async arquivar(id: string, archived: boolean) {
      await must(id);
      await touch(id, { archived });
    },

    /** Chips da operação (`campaigns.account_ids`): só ids de contas que existem. */
    async definirChips(id: string, accountIds: string[]) {
      await must(id);
      const ids = [...new Set(accountIds)];
      const found = ids.length ? await db.select({ id: waAccounts.id }).from(waAccounts).where(inArray(waAccounts.id, ids)) : [];
      await touch(id, { accountIds: found.map((a) => a.id) });
    },

    async gruposDaOperacao(id: string) {
      return db
        .select({
          id: groups.id,
          gid: groups.gid,
          name: groups.name,
          participants: groups.participantsAmount,
          admins: groups.adminsAmount,
          account: waAccounts.name,
        })
        .from(groups)
        .leftJoin(waAccounts, eq(waAccounts.id, groups.waAccountId))
        .where(eq(groups.campaignId, id))
        .orderBy(asc(groups.name));
    },

    /** Grupos que o chip enxerga no WhatsApp, marcando os que já são monitorados. */
    async buscarGrupos(operacaoId: string, accountId: string): Promise<RemoteGroup[]> {
      const op = await must(operacaoId);
      const session = await sessionOf(op, accountId);
      if (!engine!.listGroups) throw new GruposError('Este motor do WhatsApp não lista grupos.');
      const remote = await engine!.listGroups(session);
      const known = remote.length
        ? await db.select({ gid: groups.gid, campaignId: groups.campaignId }).from(groups).where(inArray(groups.gid, remote.map((g) => g.gid)))
        : [];
      const where = new Map(known.map((k) => [k.gid, k.campaignId]));
      return remote
        .map((g) => ({
          gid: g.gid,
          name: g.subject,
          participants: g.participants.length,
          monitored: where.has(g.gid) ? (where.get(g.gid) === op.id ? ('esta' as const) : ('outra' as const)) : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    },

    /** Marca os grupos como monitorados (upsert por `gid`) e semeia os participantes lendo cada grupo no WhatsApp. */
    async importar(operacaoId: string, accountId: string, gids: string[]): Promise<ImportResult> {
      const op = await must(operacaoId);
      const session = await sessionOf(op, accountId);
      const lista = [...new Set(gids)];
      if (lista.length > MAX_IMPORT) throw new GruposError(`Selecione no máximo ${MAX_IMPORT} grupos por vez.`);
      const r: ImportResult = { imported: 0, updated: 0, skipped: 0, failed: 0 };
      for (const gid of lista) {
        if (!GID.test(gid)) {
          r.failed++; // identificador inválido: aparece na contagem de falhas em vez de sumir
          continue;
        }
        const [ex] = await db.select({ campaignId: groups.campaignId }).from(groups).where(eq(groups.gid, gid));
        if (ex && ex.campaignId !== op.id) {
          r.skipped++; // já é de outra operação: não move sem querer
          continue;
        }
        let info: WaGroup;
        try {
          info = await engine!.getGroup(session, gid);
        } catch {
          r.failed++;
          continue;
        }
        // um grupo sempre tem ao menos o próprio chip: lista vazia é resposta ruim do motor e não pode zerar os participantes
        if (!info.participants.length) {
          r.failed++;
          continue;
        }
        const dados = {
          name: info.subject,
          waAccountId: accountId,
          description: info.description ?? null,
          inviteCode: inviteCodeOf(info.inviteCode),
        };
        try {
          // grupo e participantes juntos: falha no meio não deixa um grupo pela metade
          await db.transaction(async (tx) => {
            const [g] = await tx
              .insert(groups)
              .values({ campaignId: op.id, gid, ...dados })
              .onConflictDoUpdate({ target: groups.gid, set: { ...dados, updatedAt: new Date() } })
              .returning({ id: groups.id });
            await seedParticipants(tx, g!.id, info);
          });
        } catch {
          r.failed++;
          continue;
        }
        if (ex) r.updated++;
        else r.imported++;
      }
      return r;
    },

    async removerGrupo(groupId: string) {
      await db.transaction(async (tx) => {
        await tx.delete(groupParticipants).where(eq(groupParticipants.groupId, groupId));
        await tx.delete(groups).where(eq(groups.id, groupId));
      });
    },
  };
}

/**
 * Grava os participantes atuais (sem duplicar), marca como saídos os que sumiram e refaz os contadores. Quem já estava no
 * grupo entra SEM data de entrada: só o que o worker vê entrar depois ganha `joinedAt`, e é isso que a análise automática
 * (janela de 48 h) considera "recém-chegado".
 */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
async function seedParticipants(db: Db | Tx, groupId: string, info: WaGroup) {
  const now = new Date();
  // chave = telefone E.164; participante só com LID fica com o JID cru (como o worker faz)
  const byKey = new Map<string, { phone: string; lid: string | null; isAdmin: boolean }>();
  for (const p of info.participants)
    byKey.set(phoneFromJid(p.jid) ?? p.jid, {
      phone: phoneFromJid(p.jid) ?? p.jid,
      lid: p.lid ?? null,
      isAdmin: p.isAdmin || p.isSuperAdmin,
    });
  const rows = [...byKey.values()];
  if (rows.length) {
    await db
      .insert(groupParticipants)
      .values(rows.map((r) => ({ groupId, phone: r.phone, lid: r.lid, isAdmin: r.isAdmin })))
      .onConflictDoUpdate({
        target: [groupParticipants.groupId, groupParticipants.phone],
        set: {
          lid: sql`coalesce(excluded.lid, ${groupParticipants.lid})`,
          isAdmin: sql`excluded.is_admin`,
          leftAt: sql`null`,
          updatedAt: sql`now()`,
        },
      });
  }
  await db
    .update(groupParticipants)
    .set({ leftAt: now, isAdmin: false, updatedAt: now })
    .where(
      and(
        eq(groupParticipants.groupId, groupId),
        isNull(groupParticipants.leftAt),
        rows.length ? notInArray(groupParticipants.phone, rows.map((r) => r.phone)) : undefined,
      ),
    );
  await db
    .update(groups)
    .set({
      count: rows.length,
      participantsAmount: rows.length,
      adminsAmount: rows.filter((r) => r.isAdmin).length,
      updatedAt: now,
    })
    .where(eq(groups.id, groupId));
}

/** Serviço do painel: exige sessão de admin antes de qualquer acesso (redireciona para /login). */
export async function gruposService() {
  await requireAdmin();
  return createGruposService(serverDb(), serverEngine());
}
