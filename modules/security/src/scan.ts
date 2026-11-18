import { and, count, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@mag/db';
import { actions as actionsTable, actionSteps } from '@mag/db/schema';
import type { ChatMessage, GroupInfo, WaEngine } from '@mag/wa-engine';
import { recordHistory } from './record';
import { isClosed, judgeProfile } from './detect';
import { actingAccount, loadSecContext, lookupSession } from './handlers';
import { confirmRemovable } from './guard';
import { identityOf, label, jidOf, lidJid, sameIdentity, type Identity } from './identity';
import { fetchPhoto, photoHash } from './photo';
import { DrizzleSecRepo, type NewIncident, type SecRepo } from './repo';
import type { SecuritySettings } from './settings';
import { incidents, SCAN_KINDS, type IncidentAction, type IncidentRow, type ScanKind } from './tables';

/**
 * "Analisar grupos": varredura manual de todos os grupos da campanha (ação `security-scan`).
 * O runner (`scan-run.ts`) roda 1 grupo por vez por conta, com a pausa entre grupos vinda do worker; cada passo = 1
 * grupo:
 *   (a) participantes (`getGroup`) × blacklist da campanha e × admins esperados (allowlist do anti-hacker + contas
 *       nossas) → `scan.blacklisted` / `scan.unknown-admin`;
 *   (b) grupo "só admins": últimas N mensagens (`listMessages`, N = `messageLimit`, padrão 50) de fora da allowlist →
 *       `scan.non-admin-message`. Engine sem busca de mensagens (ou erro do servidor) → o passo segue só com (a) e marca
 *       `messagesUnavailable` (a tela avisa);
 *   (b2) opcional (`checkProfiles` + anti-hacker com `impersonation` ligado): foto e nome de cada estranho NÃO admin →
 *       `scan.impersonator` (foto parecida com a de referência = crítico; nome suspeito = aviso);
 *   (c) cada achado vira incidente EM ABERTO (status `open`) — NADA é feito no WhatsApp pela varredura.
 * O operador decide por linha/lote (`actOnFindings`): Remover participante · Apagar mensagem · Ignorar, executados
 * pela conta certa (mesma regra do tempo real: dona → conta da varredura → não-espiã → espiã) e registrados.
 */

/** Contexto de 1 passo da varredura (1 grupo). */
export type StepContext<P> = {
  session: string;
  gid: string;
  groupId: string | null;
  groupName?: string;
  payload: P;
  /** índice do passo dentro do filho (0-based) */
  index: number;
};

/** Definição mínima do tipo de ação `security-scan` (validação do payload + 1 passo). */
export type ActionTypeDef<P> = {
  type: string;
  label: string;
  payload: z.ZodType<P>;
  runStep(engine: WaEngine, step: StepContext<P>): Promise<{ result?: Record<string, unknown> } | void>;
};

export const SECURITY_SCAN_TYPE = 'security-scan';
export const DEFAULT_SCAN_MESSAGES = 50;

export const scanPayloadSchema = z.object({
  /** quantas mensagens recentes ler por grupo "só admins" (0 = não ler mensagens) */
  messageLimit: z.number().int().min(0).max(200).default(DEFAULT_SCAN_MESSAGES),
  /** conferir foto e nome de cada participante (impostor); mais lento: 2 consultas ao WhatsApp por pessoa */
  checkProfiles: z.boolean().default(false),
  /** só confere perfil de quem entrou a partir desta data (ISO); ausente = todo mundo */
  since: z.string().datetime().optional(),
  /** análise automática: remove e bloqueia sozinha o que a campanha permite (mesmo caminho do "Remover e bloquear") */
  autoAct: z.boolean().default(false),
});
export type ScanPayload = z.output<typeof scanPayloadSchema>;
/** payload como chega no passo (campos com padrão podem faltar em ações criadas antes de existirem) */
export type ScanPayloadInput = z.input<typeof scanPayloadSchema>;

export type ScanEngine = Pick<WaEngine, 'getGroup'> &
  Partial<Pick<WaEngine, 'listMessages' | 'getProfilePicture' | 'getContactName' | 'phoneOfLid'>>;

export type ScanDeps = {
  repo: SecRepo;
  /** interruptores globais (cache do processo); ausente = `repo.globalSettings()` */
  settings?: () => Promise<SecuritySettings>;
  /** baixa a foto de perfil (padrão `fetchPhoto`); injetável nos testes */
  loadPhoto?: (url: string) => Promise<Uint8Array | null>;
  sleep?: (ms: number) => Promise<void>;
  /** pausa entre consultas de perfil (anti-ban); padrão 300 ms */
  profileGapMs?: number;
  /** banco p/ a ação automática (`autoAct`); ausente = a análise só registra achados */
  db?: Db;
};

/** Extras que o runner da varredura passa além do `StepContext` (ver `runScanChild`). */
export type ScanStepExtras = { actionId?: string; accountId?: string; campaignId?: string | null };

export type ScanStepResult = {
  participants: number;
  findings: number;
  blacklisted: number;
  unknownAdmins: number;
  nonAdminMessages: number;
  impersonators: number;
  /** perfis conferidos / que não deu para conferir (consulta falhou ou foto ilegível) */
  profilesChecked: number;
  profilesSkipped: number;
  /** mensagens lidas; null = não leu (grupo aberto, N=0 ou indisponível) */
  messages: number | null;
  closed: boolean;
  messagesUnavailable?: string;
  /** análise automática (`autoAct`): removidos+bloqueados / não removidos (trava, falha ou erro) */
  autoRemoved: number;
  autoFailed: number;
};

export const SCAN_KIND_LABEL: Record<ScanKind, string> = {
  'scan.blacklisted': 'Bloqueado no grupo',
  'scan.non-admin-message': 'Mensagem de não-admin',
  'scan.unknown-admin': 'Admin desconhecido',
  'scan.impersonator': 'Possível impostor',
};

const whoOf = (p: { jid: string; lid?: string }) => identityOf(p.jid, lidJid(p.lid));

/** Analisa 1 grupo (passo da varredura). Lança só quando não dá p/ analisar (grupo fora do painel / engine falhou). */
export async function scanGroup(
  deps: ScanDeps,
  engine: ScanEngine,
  step: StepContext<ScanPayloadInput> & ScanStepExtras,
): Promise<ScanStepResult> {
  return (await scanGroupFindings(deps, engine, step)).result;
}

/** Como `scanGroup`, mas devolve também os achados de impostor que a campanha deixa agir sozinha (só em memória). */
export async function scanGroupFindings(
  deps: ScanDeps,
  engine: ScanEngine,
  step: StepContext<ScanPayloadInput> & ScanStepExtras,
): Promise<{ result: ScanStepResult; autoIds: string[] }> {
  const settings = await (deps.settings ?? (() => deps.repo.globalSettings()))();
  const c = await loadSecContext(deps.repo, step.gid, settings);
  if (!c) throw new Error('grupo não está cadastrado no painel');
  for (const i of await deps.repo.agencyAccounts()) c.allow.add(i);
  const scanId = step.actionId ?? 'manual';
  const { messageLimit: limit, checkProfiles, since } = scanPayloadSchema.parse(step.payload ?? {});
  const info: GroupInfo = await engine.getGroup(step.session, step.gid);

  const base = (kind: ScanKind, who: Identity, extra: Partial<NewIncident> = {}): NewIncident => ({
    kind,
    severity: kind === 'scan.unknown-admin' ? 'critical' : 'warning',
    status: 'open',
    dedupKey: `scan:${scanId}:${kind}:${step.gid}:${label(who)}`,
    campaignId: c.campaign.id,
    groupId: c.group.id,
    gid: c.group.gid,
    waAccountId: step.accountId ?? null,
    who,
    ...extra,
    details: { scanId, ...(extra.details ?? {}) },
  });

  const out: ScanStepResult = {
    participants: info.participants.length,
    findings: 0,
    blacklisted: 0,
    unknownAdmins: 0,
    nonAdminMessages: 0,
    impersonators: 0,
    profilesChecked: 0,
    profilesSkipped: 0,
    messages: null,
    closed: false,
    autoRemoved: 0,
    autoFailed: 0,
  };
  const autoIds: string[] = [];

  // (a) participantes × blacklist × admins esperados
  const strangers = info.participants.map((p) => ({ p, who: whoOf(p) })).filter(({ who }) => !c.allow.has(who));
  const blocked = await deps.repo.blockedAmong(
    strangers.map((s) => s.who),
    c.campaign.id,
  );
  const blockedSet = new Set(blocked);
  for (const { p, who } of strangers) {
    const admin = p.isAdmin || p.isSuperAdmin;
    if (blockedSet.has(who)) {
      const id = await deps.repo.recordFinding(
        base('scan.blacklisted', who, { details: { admin, jid: p.jid } }),
      );
      if (id) out.blacklisted += 1;
    } else if (admin) {
      const id = await deps.repo.recordFinding(
        base('scan.unknown-admin', who, { details: { superAdmin: p.isSuperAdmin, jid: p.jid } }),
      );
      if (id) out.unknownAdmins += 1;
    }
  }

  // (b2) impostor: foto + nome de quem não é admin nem da lista de confiança. Admin nunca é consultado nem registrado.
  // shortcut: grupo de 1000 leva ~5 min e segura a fila da conta; dividir em passos se atrapalhar os envios
  if (checkProfiles && c.cfg.enabled && c.cfg.impersonation !== 'off' && engine.getProfilePicture) {
    const loadPhoto = deps.loadPhoto ?? ((url: string) => fetchPhoto(url));
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const gap = deps.profileGapMs ?? 300;
    // com `since` só confere quem entrou na janela; quem não tem linha em group_participants só cai na análise manual (sem janela)
    const recent = since ? await deps.repo.recentJoiners(c.group.id, new Date(since)) : null;
    // só age sozinha com a campanha em `auto`; nome suspeito só quando a caixa "remover por nome" está ligada
    // "Modo simulação" promete não remover ninguém: vale também para a análise automática
    const canAct = c.cfg.enabled && c.cfg.impersonation === 'auto' && !c.cfg.dryRun;
    let asked = 0;
    for (const { p, who } of strangers) {
      if (p.isAdmin || p.isSuperAdmin || blockedSet.has(who)) continue;
      if (recent && !recent.has(who)) continue;
      // quem consulta: espiã da vez (rodízio); sem espiã no ar, não consulta pela conta que age
      const look = lookupSession(c, step.session);
      if (!look) {
        out.profilesSkipped += 1;
        continue;
      }
      if (asked++ > 0 && gap > 0) await sleep(gap);
      try {
        const url = await engine.getProfilePicture(look, p.jid);
        const bytes = url ? await loadPhoto(url) : null;
        const hash = bytes ? await photoHash(bytes) : null;
        // falha só na consulta de nome vale "sem nome": a foto ainda é avaliada (igual à entrada do grupo)
        const name = await Promise.resolve(engine.getContactName?.(look, p.jid)).catch(() => null);
        const v = judgeProfile({ name, photoHash: hash, cfg: c.cfg });
        // tem foto mas não deu para avaliar (download/imagem inválida) e o nome não casou → não foi conferido de verdade
        if (v.match === null && url && !hash) {
          out.profilesSkipped += 1;
          continue;
        }
        out.profilesChecked += 1;
        if (v.match === null) continue;
        // o achado sempre traz o número: quem está só com LID tem o telefone resolvido pelo motor
        const phone =
          who.number ??
          (await Promise.resolve(engine.phoneOfLid?.(look, lidJid(who.lid) ?? p.jid)).catch(() => null));
        const found = phone && !who.number ? identityOf(phone, lidJid(who.lid)) : who;
        const id = await deps.repo.recordFinding(
          base('scan.impersonator', found, {
            severity: v.match === 'photo' ? 'critical' : 'warning',
            details: {
              reason: v.match,
              matched: v.matched,
              profileName: name?.slice(0, 100) ?? null,
              jid: p.jid,
            },
          }),
        );
        // shortcut: `recordFinding` devolve null para achado já gravado; se o passo morreu depois de gravar, a nova tentativa
        // não age sozinha nele (fica aberto para o operador) — nunca remove duas vezes; refazer só se esse caso aparecer
        if (id) {
          out.impersonators += 1;
          if (canAct && (v.match === 'photo' || c.cfg.impersonationRemoveByName)) autoIds.push(id);
        }
      } catch {
        out.profilesSkipped += 1;
      }
    }
  }

  // (b) mensagens de não-admin em grupo "só admins"
  out.closed = info.announce ?? isClosed(c.group.settings, c.campaign.onlyAdminsSpeak);
  if (out.closed && limit > 0) {
    let msgs: ChatMessage[] | null = null;
    if (!engine.listMessages) out.messagesUnavailable = 'o WhatsApp conectado não oferece busca de mensagens';
    else
      try {
        msgs = await engine.listMessages(step.session, step.gid, { limit });
      } catch (e) {
        out.messagesUnavailable = `busca de mensagens falhou: ${(e as Error).message.slice(0, 160)}`;
      }
    if (msgs) {
      out.messages = msgs.length;
      for (const m of msgs) {
        // mensagem de sistema/protocolo (entrou, saiu, trocou nome…) não tem texto nem mídia → não é "mensagem"
        if (m.fromMe || (!m.body?.trim() && !m.hasMedia)) continue;
        const who = identityOf(m.from, m.fromAlt);
        if (!who.number && !who.lid) continue;
        if (c.allow.has(who)) continue;
        const id = await deps.repo.recordFinding(
          base('scan.non-admin-message', who, {
            dedupKey: `scan:msg:${step.gid}:${m.id}`,
            messageId: m.id,
            actor: m.from,
            details: {
              body: m.body?.slice(0, 300),
              hasMedia: m.hasMedia,
              sentAt: Number.isFinite(m.ts) && m.ts > 0 ? new Date(m.ts).toISOString() : null,
            },
          }),
          // o tempo real já tratou esta mensagem → não repete
          { skipKeys: [`msg:${step.gid}:${m.id}`] },
        );
        if (id) out.nonAdminMessages += 1;
      }
    }
  }
  out.findings = out.blacklisted + out.unknownAdmins + out.nonAdminMessages + out.impersonators;
  return { result: out, autoIds };
}

/** Remove e bloqueia os achados pelo mesmo caminho do botão "Remover e bloquear" (inclui a trava `confirmRemovable`). */
async function autoAct(deps: ScanDeps, engine: ScanEngine, ids: string[], out: ScanStepResult) {
  for (let i = 0; i < ids.length; i += MAX_FINDINGS_PER_RUN) {
    const lote = ids.slice(i, i + MAX_FINDINGS_PER_RUN);
    try {
      const r = await actOnFindings(
        { db: deps.db!, engine: engine as FindingEngine, repo: deps.repo, sleep: deps.sleep },
        lote,
        'remove',
        null,
        true,
      );
      out.autoRemoved += r.done;
      out.autoFailed += r.failed + r.skipped;
    } catch {
      out.autoFailed += lote.length;
    }
  }
}

/** 1 passo da varredura: acha e, com `autoAct`, remove+bloqueia o que a campanha deixa agir sozinha. */
export async function scanStep(
  deps: ScanDeps,
  engine: ScanEngine,
  s: StepContext<ScanPayloadInput> & ScanStepExtras,
): Promise<{ result: ScanStepResult }> {
  const { result, autoIds } = await scanGroupFindings(deps, engine, s);
  if (deps.db && autoIds.length && scanPayloadSchema.parse(s.payload ?? {}).autoAct)
    await autoAct(deps, engine, autoIds, result);
  return { result };
}

/** Tipo de ação `security-scan` (com deps roda o passo; sem deps só valida o payload). */
export function securityScanType(deps?: ScanDeps): ActionTypeDef<ScanPayload> {
  return {
    type: SECURITY_SCAN_TYPE,
    label: 'Analisar grupos (segurança)',
    payload: scanPayloadSchema as unknown as z.ZodType<ScanPayload>,
    runStep: async (engine, s) => {
      if (!deps) throw new Error('security-scan roda no worker');
      return scanStep(deps, engine, s as StepContext<ScanPayload> & ScanStepExtras);
    },
  };
}

// ── painel: iniciar, acompanhar, cancelar ─────────────────────────

const ACTIVE = ['queued', 'scheduled', 'processing', 'paused'] as const;

export type ScanView = {
  id: string;
  campaignId: string | null;
  status: string;
  total: number;
  processed: number;
  failed: number;
  createdAt: Date;
  finishedAt: Date | null;
  messageLimit: number;
  findings: number;
  open: number;
  /** grupos em que a busca de mensagens não estava disponível */
  messagesUnavailable: number;
  /** perfis (foto/nome) que não deu para conferir, somados dos grupos */
  profilesSkipped: number;
  active: boolean;
};

export class ScanAlreadyRunningError extends Error {
  constructor(readonly scanId: string) {
    super('já existe uma análise em andamento nesta campanha — acompanhe ou cancele antes de começar outra');
    this.name = 'ScanAlreadyRunningError';
  }
}

export async function activeScan(db: Db, campaignId: string): Promise<string | null> {
  const [r] = await db
    .select({ id: actionsTable.id })
    .from(actionsTable)
    .where(
      and(
        eq(actionsTable.type, SECURITY_SCAN_TYPE),
        eq(actionsTable.campaignId, campaignId),
        isNull(actionsTable.parentId),
        inArray(actionsTable.status, [...ACTIVE]),
      ),
    )
    .limit(1);
  return r?.id ?? null;
}

/** Cria a ação `security-scan` (todos os grupos, todas as contas da campanha). 1 por campanha por vez. */
export async function startScan(
  db: Db,
  create: (input: {
    type: string;
    campaignId: string;
    payload: ScanPayload;
    options: { targets: { mode: 'all' }; accounts: { from: 'campaign' } };
  }) => Promise<{ id: string }>,
  campaignId: string,
  opts: { messageLimit?: number; checkProfiles?: boolean; since?: string; autoAct?: boolean } = {},
  by?: string | null,
): Promise<string> {
  const limit = opts.messageLimit ?? DEFAULT_SCAN_MESSAGES;
  if (!Number.isInteger(limit) || limit < 0 || limit > 200)
    throw new Error('escolha entre 0 e 200 mensagens por grupo');
  const payload = scanPayloadSchema.parse({
    messageLimit: limit,
    checkProfiles: opts.checkProfiles,
    since: opts.since,
    autoAct: opts.autoAct,
  });
  // trava por campanha durante conferir + criar: duplo clique não cria 2 análises
  const a = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`security-scan:${campaignId}`}))`);
    const running = await activeScan(tx as unknown as Db, campaignId);
    if (running) throw new ScanAlreadyRunningError(running);
    return create({
      type: SECURITY_SCAN_TYPE,
      campaignId,
      payload,
      options: { targets: { mode: 'all' }, accounts: { from: 'campaign' } },
    });
  });
  await recordHistory(db, {
    location: 'seguranca',
    type: 'security.scan.start',
    entityIds: [a.id],
    after: { campaignId, ...payload },
    memberId: by ?? null,
  });
  return a.id;
}

/** Últimas análises (progresso: grupos analisados/total, achados, avisos). */
export async function listScans(db: Db, f: { campaignId?: string; limit?: number } = {}): Promise<ScanView[]> {
  const rows = await db
    .select()
    .from(actionsTable)
    .where(
      and(
        eq(actionsTable.type, SECURITY_SCAN_TYPE),
        isNull(actionsTable.parentId),
        f.campaignId ? eq(actionsTable.campaignId, f.campaignId) : undefined,
      ),
    )
    .orderBy(desc(actionsTable.createdAt))
    .limit(Math.min(Math.max(f.limit ?? 5, 1), 50));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const scanIdExpr = sql<string>`${incidents.details} ->> 'scanId'`;
  const found = await db
    .select({
      scanId: scanIdExpr,
      total: count(),
      open: sql<number>`count(*) filter (where ${incidents.resolvedAt} is null)::int`,
    })
    .from(incidents)
    .where(and(inArray(incidents.kind, [...SCAN_KINDS]), inArray(scanIdExpr, ids)))
    .groupBy(scanIdExpr);
  const unavailable = await db
    .select({ scanId: actionsTable.parentId, n: count() })
    .from(actionSteps)
    .innerJoin(actionsTable, eq(actionsTable.id, actionSteps.actionId))
    .where(
      and(
        inArray(actionsTable.parentId, ids),
        sql`${actionSteps.result} ->> 'messagesUnavailable' is not null`,
      ),
    )
    .groupBy(actionsTable.parentId);
  const skipped = await db
    .select({ scanId: actionsTable.parentId, n: sql<number>`sum((${actionSteps.result} ->> 'profilesSkipped')::int)::int` })
    .from(actionSteps)
    .innerJoin(actionsTable, eq(actionsTable.id, actionSteps.actionId))
    .where(and(inArray(actionsTable.parentId, ids), sql`${actionSteps.result} ->> 'profilesSkipped' is not null`))
    .groupBy(actionsTable.parentId);
  const sMap = new Map(skipped.map((r) => [r.scanId, Number(r.n)]));
  const fMap = new Map(found.map((r) => [r.scanId, r]));
  const uMap = new Map(unavailable.map((r) => [r.scanId, Number(r.n)]));
  return rows.map((r) => ({
    id: r.id,
    campaignId: r.campaignId,
    status: r.status,
    total: r.total,
    processed: r.processed,
    failed: r.failed,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt ?? null,
    messageLimit: Number((r.payload as { messageLimit?: unknown })?.messageLimit ?? DEFAULT_SCAN_MESSAGES),
    findings: Number(fMap.get(r.id)?.total ?? 0),
    open: Number(fMap.get(r.id)?.open ?? 0),
    messagesUnavailable: uMap.get(r.id) ?? 0,
    profilesSkipped: sMap.get(r.id) ?? 0,
    active: (ACTIVE as readonly string[]).includes(r.status),
  }));
}

// ── operador: Remover participante · Apagar mensagem · Ignorar ────

export const FINDING_OPS = ['remove', 'delete', 'ignore'] as const;
export type FindingOp = (typeof FINDING_OPS)[number];
export const FINDING_OP_LABEL: Record<FindingOp, string> = {
  remove: 'Remover participante',
  delete: 'Apagar mensagem',
  ignore: 'Ignorar',
};

export type FindingEngine = Pick<WaEngine, 'removeParticipants' | 'deleteMessage' | 'getGroup'> &
  Partial<Pick<WaEngine, 'phoneOfLid'>>;

export type FindingDeps = {
  db: Db;
  engine?: FindingEngine;
  repo?: SecRepo;
  /** pausa entre chamadas ao WhatsApp (anti-ban); padrão 1,5 s */
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type FindingResult = { done: number; failed: number; skipped: number; notes: string[] };


/**
 * Por clique: cada chamada ao WhatsApp tem pausa de 1,5 s e roda dentro da server action — 20 achados ≈ 30 s,
 * abaixo do tempo limite do proxy. Mais que isso o operador faz em lotes.
 */
export const MAX_FINDINGS_PER_RUN = 20;

const identityOfRow = (r: Pick<IncidentRow, 'phone' | 'lid'>) => identityOf(r.phone, lidJid(r.lid));

/** Claim de quem está agindo no achado (`details.claimedAt`): sem coluna/status novo; expira sozinho se o processo morrer. */
const CLAIM_FREE = sql`((${incidents.details} ->> 'claimedAt') is null or (${incidents.details} ->> 'claimedAt')::timestamptz < now() - interval '10 minutes')`;

/**
 * Executa a decisão do operador sobre achados em aberto da varredura. Cada linha recebe a ação feita (quem/conta,
 * ok/erro) em `actions`; sucesso → `acted` + resolvido; erro → `failed` (continua em aberto p/ tentar de novo).
 * Uma transação curta reivindica as linhas (`FOR UPDATE SKIP LOCKED` + `details.claimedAt`) e termina ANTES de falar com o
 * WhatsApp (o transaction_timeout de 60 s mataria o lote no meio); cada linha é fechada numa escrita própria e o claim é
 * solto no fim. Duplo clique ou 2 operadores ao mesmo tempo não chamam o WhatsApp 2x — quem chega depois vê "sem mudança".
 * Antes de remover, reconfere a allowlist (o número pode
 * ter virado colaborador/admin depois da varredura); removido com sucesso → os outros achados abertos da mesma pessoa
 * no mesmo grupo também são fechados.
 */
export async function actOnFindings(
  deps: FindingDeps,
  ids: string[],
  op: FindingOp,
  by?: string | null,
  /** só com `remove`: quem saiu do grupo entra também na lista de bloqueados da campanha */
  block?: boolean,
): Promise<FindingResult> {
  const { db } = deps;
  const res: FindingResult = { done: 0, failed: 0, skipped: 0, notes: [] };
  const all = [...new Set(ids)];
  const uniq = all.slice(0, MAX_FINDINGS_PER_RUN);
  if (all.length > uniq.length) {
    res.skipped += all.length - uniq.length;
    res.notes.push(`No máximo ${MAX_FINDINGS_PER_RUN} por vez — selecione o restante e repita.`);
  }
  if (!uniq.length) return res;
  if (op !== 'ignore' && !deps.engine) throw new Error('WhatsApp não configurado neste servidor (WAHA_URL)');

  const claim = new Date().toISOString();
  const rows = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(incidents)
      .where(
        and(
          inArray(incidents.id, uniq),
          inArray(incidents.kind, [...SCAN_KINDS]),
          isNull(incidents.resolvedAt),
          inArray(incidents.status, ['open', 'failed']),
          CLAIM_FREE,
        ),
      )
      .for('update', { skipLocked: true });
    res.skipped += uniq.length - rows.length;
    if (!rows.length) return rows;

    const ids = rows.map((r) => r.id);
    if (op === 'ignore') {
      await tx
        .update(incidents)
        .set({ status: 'ignored', resolvedAt: sql`now()`, resolvedBy: by ?? null })
        .where(inArray(incidents.id, ids));
      res.done = rows.length;
    } else {
      await tx
        .update(incidents)
        .set({ details: sql`${incidents.details} || ${JSON.stringify({ claimedAt: claim })}::jsonb` })
        .where(inArray(incidents.id, ids));
    }
    return rows;
  });
  let handled = rows;
  if (op !== 'ignore' && rows.length) {
    try {
      handled = await runOnWhatsApp(deps, rows, op, res, by, block);
    } finally {
      // solta o claim (as linhas já fechadas ficam resolvidas; as "failed" voltam a poder ser tentadas)
      await db
        .update(incidents)
        .set({ details: sql`${incidents.details} - 'claimedAt'` })
        .where(and(inArray(incidents.id, rows.map((r) => r.id)), sql`${incidents.details} ->> 'claimedAt' = ${claim}`));
    }
  }
  await history(db, op, handled, res, by);
  return res;
}

async function runOnWhatsApp(
  deps: FindingDeps,
  rows: IncidentRow[],
  op: Exclude<FindingOp, 'ignore'>,
  res: FindingResult,
  by?: string | null,
  block?: boolean,
): Promise<IncidentRow[]> {
  const { db } = deps;
  const engine = deps.engine!;
  const repo = deps.repo ?? new DrizzleSecRepo(db);
  const settings = await repo.globalSettings();
  const agency = await repo.agencyAccounts();
  const gap = deps.gapMs ?? 1500;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let calls = 0;
  const pace = async () => {
    if (calls++ > 0 && gap > 0) await sleep(gap);
  };

  const todo = op === 'delete' ? rows.filter((r) => r.kind === 'scan.non-admin-message' && r.messageId) : rows;
  if (op === 'delete' && todo.length < rows.length) {
    res.skipped += rows.length - todo.length;
    res.notes.push('"Apagar mensagem" só vale para achados de mensagem — os outros ficaram como estavam.');
  }

  const byGroup = new Map<string, IncidentRow[]>();
  for (const r of todo) if (r.gid) byGroup.set(r.gid, [...(byGroup.get(r.gid) ?? []), r]);

  for (const [gid, list] of byGroup) {
    const c = await loadSecContext(repo, gid, settings);
    const hint = c?.accounts.find((a) => a.id === list[0]!.waAccountId)?.sessionName ?? '';
    const acc = c ? actingAccount(c, hint) : null;
    if (!c || !acc) {
      const error = c ? 'nenhuma conta da campanha conectada neste grupo' : 'grupo não está mais no painel';
      for (const r of list) await finish(db, r, [{ type: FINDING_OP_LABEL[op], ok: false, error }], 'failed', by);
      res.failed += list.length;
      continue;
    }
    // mesma lista de confiança da varredura (inclui todas as contas nossas)
    for (const i of agency) c.allow.add(i);

    if (op === 'remove') {
      // impostor: remover só com a trava central (confirmRemovable: membro, não-admin, fora da lista oficial) — 1 consulta por pessoa
      const ok: IncidentRow[] = [];
      const jids = new Map<string, string>();
      // 1º passo: a trava decide cada impostor; quem ela recusa não sai por nenhuma outra linha do mesmo clique
      const refused: { id: string; who: Identity; error: string }[] = [];
      for (const r of list) {
        const who = identityOfRow(r);
        if (r.kind !== 'scan.impersonator' || c.allow.has(who)) continue;
        await pace();
        const chk = await confirmRemovable({ engine, session: acc.sessionName, gid, who, allow: c.allow, repo });
        if (chk.ok) jids.set(r.id, chk.jid);
        else refused.push({ id: r.id, who, error: `${chk.reason} — não removido` });
      }
      for (const r of list) {
        const who = identityOfRow(r);
        if (c.allow.has(who)) {
          res.skipped += 1;
          res.notes.push(`${label(who)} agora está na lista de confiança — não removido.`);
          continue;
        }
        // pelo id da linha também: linha sem telefone nem LID não casa por identidade e não pode passar como "feita"
        const no = refused.find((x) => x.id === r.id || sameIdentity(x.who, who) || sameIdentity(who, x.who));
        if (no) {
          await finish(db, r, [{ type: FINDING_OP_LABEL[op], ok: false, error: no.error }], 'failed', by);
          res.skipped += 1;
          res.notes.push(`${label(who)}: ${no.error}.`);
          continue;
        }
        ok.push(r);
      }
      const jidFor = (r: IncidentRow) => jids.get(r.id) ?? jidOf(identityOfRow(r));
      // 1 chamada por grupo com todos os números (o WhatsApp aceita lote)
      const targets = [...new Set(ok.map(jidFor))].filter(Boolean);
      if (!targets.length) continue;
      await pace();
      let per: { jid: string; ok: boolean; error?: string }[] = [];
      let err: string | undefined;
      try {
        per = await engine.removeParticipants(acc.sessionName, gid, targets);
      } catch (e) {
        err = (e as Error).message.slice(0, 200);
      }
      const removed: IncidentRow[] = [];
      for (const r of ok) {
        const jid = jidFor(r);
        const hit = per.find((p) => p.jid === jid) ?? (per.length === 1 && targets.length === 1 ? per[0] : undefined);
        const good = !err && (hit ? hit.ok : per.length === 0 || per.every((p) => p.ok));
        const error = err ?? (good ? undefined : (hit?.error ?? 'falhou'));
        const action = actionOf(op, label(identityOfRow(r)), acc.sessionName, good, error);
        const actions = [action];
        // "Remover e bloquear": só bloqueia quem a remoção deu certo (trava recusou/falhou → não chega aqui)
        if (good && block) {
          const who = identityOfRow(r);
          const b: IncidentAction = { type: 'bloquear', target: label(who), ok: true };
          try {
            await repo.block({ campaign: c.campaign, who, name: `Removido ${label(who)}`, toAntiSpam: c.cfg.sendToAntiSpam });
          } catch (e) {
            Object.assign(b, { ok: false, error: (e as Error).message.slice(0, 200) });
          }
          actions.push(b);
        }
        await finish(db, r, actions, good ? 'acted' : 'failed', by);
        if (good) {
          res.done += 1;
          removed.push(r);
        } else res.failed += 1;
      }
      await closeSiblings(db, removed, list, acc.sessionName, by);
      continue;
    }

    for (const r of list) {
      await pace();
      let error: string | undefined;
      try {
        await engine.deleteMessage(acc.sessionName, gid, r.messageId!);
      } catch (e) {
        error = (e as Error).message.slice(0, 200);
      }
      await finish(db, r, [actionOf(op, r.messageId!, acc.sessionName, !error, error)], error ? 'failed' : 'acted', by);
      if (error) res.failed += 1;
      else res.done += 1;
    }
  }
  return todo;
}

/** Quem saiu do grupo: os outros achados abertos da mesma pessoa no mesmo grupo também ficam resolvidos. */
async function closeSiblings(db: Db, removed: IncidentRow[], handled: IncidentRow[], session: string, by?: string | null) {
  const skip = handled.map((r) => r.id);
  for (const r of removed) {
    const who = [r.phone ? eq(incidents.phone, r.phone) : undefined, r.lid ? eq(incidents.lid, r.lid) : undefined].filter(
      (x) => x !== undefined,
    );
    if (!r.groupId || !who.length) continue;
    const note: IncidentAction[] = [
      { type: 'removido-em-outro-achado', target: `${label(identityOfRow(r))} (conta ${session})`, ok: true },
    ];
    await db
      .update(incidents)
      .set({
        status: 'acted',
        resolvedAt: sql`now()`,
        resolvedBy: by ?? null,
        actions: sql`${incidents.actions} || ${JSON.stringify(note)}::jsonb`,
      })
      .where(
        and(
          eq(incidents.groupId, r.groupId),
          inArray(incidents.kind, [...SCAN_KINDS]),
          inArray(incidents.status, ['open', 'failed']),
          isNull(incidents.resolvedAt),
          or(...who),
          notInArray(incidents.id, skip),
        ),
      );
  }
}

const actionOf = (op: FindingOp, target: string, session: string, ok: boolean, error?: string): IncidentAction => ({
  type: op === 'remove' ? 'remover-participante' : 'apagar-mensagem',
  target: `${target} (conta ${session})`,
  ok,
  ...(error ? { error } : {}),
});

async function finish(db: Db, r: IncidentRow, add: IncidentAction[], status: 'acted' | 'failed', by?: string | null) {
  await db
    .update(incidents)
    .set({
      status,
      actions: [...(r.actions ?? []), ...add],
      ...(status === 'acted' ? { resolvedAt: sql`now()`, resolvedBy: by ?? null } : {}),
    })
    .where(eq(incidents.id, r.id));
}

async function history(db: Db, op: FindingOp, rows: IncidentRow[], res: FindingResult, by?: string | null) {
  if (!rows.length) return;
  await recordHistory(db, {
    location: 'seguranca',
    type: `security.finding.${op}`,
    entityIds: rows.map((r) => r.id),
    after: { done: res.done, failed: res.failed, skipped: res.skipped },
    memberId: by ?? null,
  });
}
