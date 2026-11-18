import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { alerts, campaigns, groupParticipants, groups, waAccounts } from '@mag/db/schema';
import { brPhoneVariants } from '@mag/shared/phone';
import { admins, lists, numbers } from '../../blacklist/tables';
import { isBlocked, matchBlocked } from '../../blacklist/check';
import { blockAuthor } from './antispam';
import { readAntiHacker } from './config';
import { identityOf, IdentitySet, lidJid, type Identity } from './identity';
import { readSecuritySettings, type SecuritySettings } from './settings';
import {
  collaborators,
  incidents,
  type IncidentAction,
  type IncidentKind,
  type IncidentStatus,
  type Severity,
} from './tables';

/** O que os handlers do anti-golpista precisam do banco (Drizzle de verdade, memória nos testes). */

export type SecAccount = {
  id: string;
  sessionName: string;
  jid: string | null;
  lid: string | null;
  status: string;
  role: string;
  /** false = conta nossa de FORA da campanha que está no grupo (com "só contas associadas" desligado) */
  associated?: boolean;
  /** conta de fora da campanha listada em `impersonationLookupAccountIds`: só consulta foto/nome */
  lookup?: boolean;
};

export type SecGroupContext = {
  group: {
    id: string;
    gid: string;
    name: string;
    description: string | null;
    inviteCode: string | null;
    settings: Record<string, unknown>;
    waAccountId: string | null;
  };
  campaign: {
    id: string;
    name: string;
    antiHacker: unknown;
    onlyAdminsSpeak: boolean;
    autoDenyBlocked: boolean;
    templateAdmins: string[];
  };
  accounts: SecAccount[];
};

export type NewIncident = {
  kind: IncidentKind;
  severity: Severity;
  status: IncidentStatus;
  dedupKey: string;
  campaignId: string | null;
  groupId: string | null;
  waAccountId: string | null;
  gid: string | null;
  who?: Identity;
  actor?: string | null;
  messageId?: string | null;
  details?: Record<string, unknown>;
};

export type GroupContextOptions = {
  /** true (padrão) = só contas da campanha; false = + outras contas nossas presentes no grupo */
  associatedOnly?: boolean;
};

export interface SecRepo {
  groupContext(gid: string, opts?: GroupContextOptions): Promise<SecGroupContext | null>;
  /** interruptores globais (os handlers aplicam cache de 60 s) */
  globalSettings(): Promise<SecuritySettings>;
  /** telefone/LID de todas as contas WhatsApp nossas (nunca são achado da varredura) */
  agencyAccounts(): Promise<Identity[]>;
  /**
   * Grava um achado EM ABERTO. null = já existe (mesma dedup_key, uma das `skipKeys` — p.ex. o tempo real já
   * tratou a mensagem — ou um achado aberto igual: mesmo tipo, grupo, número/LID e mensagem).
   */
  recordFinding(i: NewIncident, opts?: { skipKeys?: string[] }): Promise<string | null>;
  /** números administrativos + colaboradores verificados da campanha */
  trusted(campaignId: string): Promise<Identity[]>;
  /** insere se a dedup_key é nova; null = outro evento (outra conta) já tratou */
  claimIncident(i: NewIncident): Promise<string | null>;
  finishIncident(id: string, r: { status: IncidentStatus; actions: IncidentAction[] }): Promise<void>;
  block(i: { campaign: { id: string; name: string }; who: Identity; name: string; toAntiSpam: boolean }): Promise<void>;
  isBlocked(who: Identity, campaignId: string): Promise<boolean>;
  /** quais destes estão bloqueados na campanha (mesma regra de `isBlocked`, numa consulta só) */
  blockedAmong(whos: Identity[], campaignId: string): Promise<Identity[]>;
  /** quem entrou no grupo a partir de `since` e continua nele (`group_participants`; sem linha = fora da lista) */
  recentJoiners(groupId: string, since: Date): Promise<IdentitySet>;
  alert(a: {
    type: string;
    campaignId: string | null;
    groupId: string | null;
    waAccountId: string | null;
    data: Record<string, unknown>;
  }): Promise<void>;
}

type AccountRow = {
  id: string;
  sessionName: string;
  jid: string | null;
  lid: string | null;
  status: string;
  rolePolicy: { role?: string } | null;
};

const keyOf = (w: Identity) => w.number ?? (w.lid ? `${w.lid}@lid` : null);

export class DrizzleSecRepo implements SecRepo {
  constructor(readonly db: Db) {}

  async globalSettings(): Promise<SecuritySettings> {
    const { antiSpamAssociatedOnly, sharedBlocklistAllCampaigns } = await readSecuritySettings(this.db);
    return { antiSpamAssociatedOnly, sharedBlocklistAllCampaigns };
  }

  /** Todas as contas WhatsApp (poucas dezenas) com cache de 60 s: varredura e anti-spam não consultam a cada evento. */
  private accountsCache: { at: number; rows: Promise<AccountRow[]> } | null = null;
  private allAccounts(): Promise<AccountRow[]> {
    const now = Date.now();
    if (!this.accountsCache || now - this.accountsCache.at > 60_000) {
      const rows = this.db
        .select({
          id: waAccounts.id,
          sessionName: waAccounts.sessionName,
          jid: waAccounts.jid,
          lid: waAccounts.lid,
          status: waAccounts.status,
          rolePolicy: waAccounts.rolePolicy,
        })
        .from(waAccounts);
      this.accountsCache = { at: now, rows };
      rows.catch(() => (this.accountsCache = null));
    }
    return this.accountsCache.rows;
  }

  async agencyAccounts(): Promise<Identity[]> {
    return (await this.allAccounts())
      .map((a) => identityOf(a.jid, lidJid(a.lid)))
      .filter((i) => i.number || i.lid);
  }

  /**
   * Achado igual já registrado = mesmo tipo + grupo + mensagem e mesmo telefone OU mesmo LID (a 1ª análise pode ter
   * visto só o LID), ainda em aberto/falhou — ou IGNORADO pelo operador (não volta a cada análise; p/ voltar a
   * aparecer, o operador desfaz no painel). Removido/apagado (`acted`) não conta: se voltou ao grupo, é achado novo.
   */
  async recordFinding(i: NewIncident, opts: { skipKeys?: string[] } = {}): Promise<string | null> {
    const keys = [i.dedupKey, ...(opts.skipKeys ?? [])];
    const who = [
      i.who?.number ? eq(incidents.phone, i.who.number) : undefined,
      i.who?.lid ? eq(incidents.lid, i.who.lid) : undefined,
    ].filter((x) => x !== undefined);
    const [dup] = await this.db
      .select({ id: incidents.id })
      .from(incidents)
      .where(
        or(
          inArray(incidents.dedupKey, keys),
          i.groupId && who.length
            ? and(
                eq(incidents.groupId, i.groupId),
                eq(incidents.kind, i.kind),
                inArray(incidents.status, ['open', 'failed', 'ignored']),
                or(...who),
                sql`coalesce(${incidents.messageId}, '') = ${i.messageId ?? ''}`,
              )
            : undefined,
        ),
      )
      .limit(1);
    if (dup) return null;
    return this.claimIncident(i);
  }

  async groupContext(gid: string, opts: GroupContextOptions = {}): Promise<SecGroupContext | null> {
    const [row] = await this.db
      .select({
        id: groups.id,
        gid: groups.gid,
        name: groups.name,
        description: groups.description,
        inviteCode: groups.inviteCode,
        settings: groups.settings,
        waAccountId: groups.waAccountId,
        campaignId: campaigns.id,
        campaignName: campaigns.name,
        antiHacker: campaigns.antiHacker,
        template: campaigns.groupTemplate,
        accountIds: campaigns.accountIds,
      })
      .from(groups)
      .innerJoin(campaigns, eq(campaigns.id, groups.campaignId))
      .where(eq(groups.gid, gid))
      .limit(1);
    if (!row) return null;
    const ids = [...new Set([...(row.accountIds ?? []), ...(row.waAccountId ? [row.waAccountId] : [])])];
    const accs = ids.length
      ? await this.db
          .select({
            id: waAccounts.id,
            sessionName: waAccounts.sessionName,
            jid: waAccounts.jid,
            lid: waAccounts.lid,
            status: waAccounts.status,
            rolePolicy: waAccounts.rolePolicy,
          })
          .from(waAccounts)
          .where(inArray(waAccounts.id, ids))
      : [];
    const extras = opts.associatedOnly === false ? await this.accountsInGroup(row.id, ids) : [];
    // chips só de consulta (fora da campanha): entram no contexto mesmo com "só associadas" ligado
    const lookupIds = readAntiHacker(row.antiHacker).impersonationLookupAccountIds.filter((id) => !ids.includes(id));
    if (lookupIds.length) {
      const have = new Map(extras.map((a) => [a.id, a]));
      for (const a of (await this.allAccounts()).filter((x) => lookupIds.includes(x.id))) {
        const hit = have.get(a.id);
        if (hit) hit.lookup = true;
        else
          extras.push({
            id: a.id,
            sessionName: a.sessionName,
            jid: a.jid,
            lid: a.lid,
            status: a.status,
            role: a.rolePolicy?.role ?? 'both',
            associated: false,
            lookup: true,
          });
      }
    }
    const t = (row.template ?? {}) as Record<string, unknown>;
    const tAdmins = Array.isArray(t.admins) ? t.admins : [];
    return {
      group: {
        id: row.id,
        gid: row.gid,
        name: row.name,
        description: row.description ?? null,
        inviteCode: row.inviteCode ?? null,
        settings: (row.settings ?? {}) as Record<string, unknown>,
        waAccountId: row.waAccountId ?? null,
      },
      campaign: {
        id: row.campaignId,
        name: row.campaignName,
        antiHacker: row.antiHacker,
        onlyAdminsSpeak: Boolean(t.onlyAdminsSpeak),
        autoDenyBlocked: t.joinApprovalAutoDenyBlocked !== false,
        templateAdmins: tAdmins
          .map((a) => (typeof a === 'string' ? a : String((a as { number?: unknown })?.number ?? '')))
          .filter(Boolean),
      },
      accounts: [
        ...accs.map((a) => ({
          id: a.id,
          sessionName: a.sessionName,
          jid: a.jid,
          lid: a.lid,
          status: a.status,
          role: a.rolePolicy?.role ?? 'both',
          associated: true,
        })),
        ...extras,
      ],
    };
  }

  /** contas nossas fora da campanha que são participantes ativos do grupo (`group_participants`). */
  private async accountsInGroup(groupId: string, exclude: string[]): Promise<SecAccount[]> {
    const skip = new Set(exclude);
    const others = (await this.allAccounts()).filter((a) => !skip.has(a.id));
    const idOf = (a: AccountRow) => identityOf(a.jid, lidJid(a.lid));
    const phones = others.map((a) => idOf(a).number).filter((x): x is string => !!x);
    const lids = others.map((a) => idOf(a).lid).filter((x): x is string => !!x);
    if (!phones.length && !lids.length) return [];
    const present = await this.db
      .select({ phone: groupParticipants.phone, lid: groupParticipants.lid })
      .from(groupParticipants)
      .where(
        and(
          eq(groupParticipants.groupId, groupId),
          isNull(groupParticipants.leftAt),
          or(
            phones.length ? inArray(groupParticipants.phone, phones) : undefined,
            lids.length ? inArray(groupParticipants.lid, lids.flatMap((l) => [l, `${l}@lid`])) : undefined,
          ),
        ),
      );
    const inGroup = new IdentitySet(present.map((p) => identityOf(p.phone, lidJid(p.lid))));
    return others
      .filter((a) => inGroup.has(idOf(a)))
      .map((a) => ({
        id: a.id,
        sessionName: a.sessionName,
        jid: a.jid,
        lid: a.lid,
        status: a.status,
        role: a.rolePolicy?.role ?? 'both',
        associated: false,
      }));
  }

  async trusted(campaignId: string): Promise<Identity[]> {
    const [adm, col] = await Promise.all([
      this.db.select({ number: admins.number, lid: admins.lid }).from(admins),
      this.db
        .select({ number: collaborators.number, lid: collaborators.lid })
        .from(collaborators)
        .where(eq(collaborators.campaignId, campaignId)),
    ]);
    return [...adm, ...col].map((r) => identityOf(r.number, lidJid(r.lid)));
  }

  async claimIncident(i: NewIncident): Promise<string | null> {
    const [row] = await this.db
      .insert(incidents)
      .values({
        kind: i.kind,
        severity: i.severity,
        status: i.status,
        dedupKey: i.dedupKey,
        campaignId: i.campaignId,
        groupId: i.groupId,
        waAccountId: i.waAccountId,
        gid: i.gid,
        phone: i.who?.number ?? null,
        lid: i.who?.lid ?? null,
        actor: i.actor ?? null,
        messageId: i.messageId ?? null,
        details: i.details ?? {},
      })
      .onConflictDoNothing({ target: incidents.dedupKey })
      .returning({ id: incidents.id });
    return row?.id ?? null;
  }

  async finishIncident(id: string, r: { status: IncidentStatus; actions: IncidentAction[] }) {
    await this.db.update(incidents).set({ status: r.status, actions: r.actions }).where(eq(incidents.id, id));
  }

  async block(i: Parameters<SecRepo['block']>[0]) {
    await blockAuthor(this.db, i);
  }

  async isBlocked(who: Identity, campaignId: string) {
    const k = keyOf(who);
    if (!k) return false;
    if ((await isBlocked(this.db, k, { campaignId })).blocked) return true;
    // participante com telefone + LID: confere os dois
    return !!(who.number && who.lid && (await isBlocked(this.db, `${who.lid}@lid`, { campaignId })).blocked);
  }

  async recentJoiners(groupId: string, since: Date): Promise<IdentitySet> {
    const rows = await this.db
      .select({ phone: groupParticipants.phone, lid: groupParticipants.lid })
      .from(groupParticipants)
      .where(
        and(
          eq(groupParticipants.groupId, groupId),
          isNull(groupParticipants.leftAt),
          gte(groupParticipants.joinedAt, since),
        ),
      );
    return new IdentitySet(rows.map((r) => identityOf(r.phone, lidJid(r.lid))));
  }

  async blockedAmong(whos: Identity[], campaignId: string): Promise<Identity[]> {
    const variants = [...new Set(whos.flatMap((w) => (w.number ? brPhoneVariants(w.number) : [])))];
    const lidKeys = [...new Set(whos.map((w) => w.lid).filter((x): x is string => !!x))];
    if (!variants.length && !lidKeys.length) return [];
    const by = (num: typeof numbers.number | typeof admins.number, lid: typeof numbers.lid | typeof admins.lid) =>
      or(variants.length ? inArray(num, variants) : undefined, lidKeys.length ? inArray(lid, lidKeys) : undefined);
    const [adm, rows] = await Promise.all([
      this.db.select({ number: admins.number, lid: admins.lid }).from(admins).where(by(admins.number, admins.lid)),
      this.db
        .select({
          listId: numbers.blacklistId,
          number: numbers.number,
          lid: numbers.lid,
          campaignIds: lists.campaignIds,
          disabled: lists.disabled,
        })
        .from(numbers)
        .innerJoin(lists, eq(lists.id, numbers.blacklistId))
        .where(and(by(numbers.number, numbers.lid), eq(lists.disabled, false))),
    ]);
    if (!rows.length) return [];
    // mesma regra do isBlocked: telefone primeiro; participante com telefone + LID confere os dois
    const hit = (w: Identity) => {
      if (w.number) {
        const r = matchBlocked(rows, adm, { number: w.number }, campaignId);
        if (r.admin) return false;
        if (r.blocked) return true;
      }
      return !!w.lid && matchBlocked(rows, adm, { lid: w.lid }, campaignId).blocked;
    };
    return whos.filter(hit);
  }

  async alert(a: Parameters<SecRepo['alert']>[0]) {
    await this.db.insert(alerts).values({
      type: a.type,
      campaignId: a.campaignId,
      groupId: a.groupId,
      waAccountId: a.waAccountId,
      data: a.data,
    });
  }
}

/** Incidentes abertos (não resolvidos) — usado pelo indicador da campanha. */
export async function openIncidentCount(db: Db, campaignId?: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(incidents)
    .where(
      and(
        isNull(incidents.resolvedAt),
        campaignId ? eq(incidents.campaignId, campaignId) : undefined,
        or(
          eq(incidents.status, 'acted'),
          eq(incidents.status, 'partial'),
          eq(incidents.status, 'failed'),
          eq(incidents.status, 'open'),
        ),
      ),
    );
  return r?.n ?? 0;
}
