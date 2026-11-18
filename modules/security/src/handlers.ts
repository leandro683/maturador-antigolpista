import type { EventParticipant, WaEngine, WaEvent, WahaWebhook } from '@mag/wa-engine';
import { readAntiHacker, type AntiHackerConfig } from './config';
import { changedFields, isClosed, judgeMessage, judgeProfile, messageAuthor } from './detect';
import { confirmRemovable, resolveIdentity } from './guard';
import { identityOf, IdentitySet, jidOf, label, lidJid, type Identity } from './identity';
import { ReactionLimiter } from './limiter';
import { fetchPhoto, photoHash } from './photo';
import type { NewIncident, SecAccount, SecGroupContext, SecRepo } from './repo';
import { cachedSettings, type SecuritySettings } from './settings';
import type { IncidentAction, IncidentStatus } from './tables';

/**
 * Handlers do anti-hacker p/ o roteador `wa-events`:
 * (a) message.in de fora da allowlist em grupo fechado, ou com conteúdo suspeito → apaga, remove, bloqueia;
 * (b) promote de número fora da allowlist → rebaixa (+ remove), e o autor da promoção também;
 * (c) group.update de nome/descrição por não-autorizado → reverte p/ os valores do painel; invite → só incidente;
 * (d) conta da campanha rebaixada/removida por não-autorizado → alerta crítico + re-promove/re-adiciona via outra conta;
 * (e) participante bloqueado que entrou → removido.
 * Cada evento chega por todas as contas da campanha no grupo: `dedup_key` UNIQUE garante 1 ação. Loop guard:
 * `ReactionLimiter` por grupo+tipo, e eventos causados pelas próprias contas (allowlist) não disparam nada.
 * (f) anti-impostor na entrada: foto parecida com a arte oficial (modo auto remove) ou nome de "Suporte" (só incidente);
 * a remoção passa pela trava `confirmRemovable`: admin, lista oficial ou qualquer dúvida nunca remove ninguém.
 */

export type SecEngine = Pick<
  WaEngine,
  | 'deleteMessage'
  | 'removeParticipants'
  | 'addParticipants'
  | 'promote'
  | 'demote'
  | 'setSubject'
  | 'setDescription'
  | 'getGroup'
> &
  Partial<Pick<WaEngine, 'getProfilePicture' | 'getContactName' | 'phoneOfLid'>>;

export type SecDeps = {
  repo: SecRepo;
  engine: SecEngine;
  limiter?: ReactionLimiter;
  /** consultas de perfil (foto/nome) na entrada do grupo; chave = sessão. Padrão: 30 por minuto */
  profileLimiter?: ReactionLimiter;
  /** baixa a foto de perfil; padrão `fetchPhoto` */
  loadPhoto?: (url: string) => Promise<Uint8Array | null>;
  log?: (m: string) => void;
  /** interruptores globais; ausente = `repo.globalSettings()` direto (a fábrica põe cache de 60 s) */
  settings?: () => Promise<SecuritySettings>;
};

export type SecResult = {
  handled: boolean;
  note?: string;
  incidents?: string[];
  /** só `group.update`: a mudança de nome/descrição é de confiança (autor autorizado, sem mudança ou proteção desligada) e o dono do grupo pode gravá-la */
  accepted?: boolean;
};

const WORKING = new Set(['active', 'connected']);

export type SecContext = SecGroupContext & {
  cfg: AntiHackerConfig;
  /** números administrativos ∪ colaboradores ∪ admins do modelo ∪ extras da config ∪ contas (campanha + de fora) */
  allow: IdentitySet;
  /** contas da campanha (protegidas pelo (d)) */
  ours: IdentitySet;
  settings: SecuritySettings;
};
type Ctx = SecContext;

const accId = (a: SecAccount) => identityOf(a.jid, lidJid(a.lid));

/** Contexto do grupo com allowlist e interruptores globais — mesmo cálculo p/ tempo real, varredura e operador. */
export async function loadSecContext(
  repo: SecRepo,
  gid: string,
  settings: SecuritySettings,
): Promise<SecContext | null> {
  const c = await repo.groupContext(gid, { associatedOnly: settings.antiSpamAssociatedOnly });
  if (!c) return null;
  const cfg = readAntiHacker(c.campaign.antiHacker);
  const ours = new IdentitySet(c.accounts.filter((a) => a.associated !== false).map(accId));
  const allow = new IdentitySet([
    ...(await repo.trusted(c.campaign.id)),
    ...c.campaign.templateAdmins.map((n) => identityOf(n)),
    ...cfg.allowedAdminNumbers.map((n) => identityOf(n)),
  ]);
  for (const a of c.accounts) allow.add(accId(a));
  return { ...c, cfg, allow, ours, settings };
}

async function load(deps: SecDeps, gid: string): Promise<Ctx | null> {
  const settings = await (deps.settings ?? (() => deps.repo.globalSettings()))();
  return loadSecContext(deps.repo, gid, settings);
}

/**
 * Conta que age: dona do grupo → conta que recebeu o evento → qualquer conectada não-espiã → espiã — sempre entre as
 * contas da campanha. Com "só contas associadas" desligado: sem conta da campanha conectada, cai p/ uma conta
 * nossa de fora da campanha que está no grupo (a que recebeu o evento → não-espiã → qualquer).
 */
export function actingAccount(c: SecGroupContext, session: string, exclude: Identity[] = []): SecAccount | null {
  const ex = new IdentitySet(exclude);
  const usable = c.accounts.filter((a) => WORKING.has(a.status) && !ex.has(accId(a)));
  const ok = usable.filter((a) => a.associated !== false);
  const extra = usable.filter((a) => a.associated === false);
  return (
    ok.find((a) => a.id === c.group.waAccountId) ??
    ok.find((a) => a.sessionName === session) ??
    ok.find((a) => a.role !== 'spy') ??
    ok[0] ??
    extra.find((a) => a.sessionName === session) ??
    extra.find((a) => a.role !== 'spy') ??
    extra[0] ??
    c.accounts.find((a) => a.associated !== false && a.sessionName === session && !ex.has(accId(a))) ??
    null
  );
}

let lookupTurn = 0;
/**
 * Sessão que consulta foto/nome/telefone. Campanha com chip de consulta (conta espiã da campanha ou conta de fora
 * listada em `impersonationLookupAccountIds`): só eles, conectados, em rodízio; o chip que remove nunca faz a parte
 * repetitiva (risco de ban) e, sem chip de consulta no ar, ninguém consulta (null). Campanha sem chip de consulta: a
 * própria conta que age, como sempre foi.
 */
export function lookupSession(c: SecGroupContext, acting: string): string | null {
  const spies = c.accounts.filter((a) => a.lookup || (a.associated !== false && a.role === 'spy'));
  if (!spies.length) return acting;
  const on = spies.filter((a) => WORKING.has(a.status));
  return on.length ? on[lookupTurn++ % on.length]!.sessionName : null;
}

/** Autor de um group.v2.* no webhook cru do GOWS (`_data.SenderPN`/`Sender`). */
export function rawActor(raw: WahaWebhook | null | undefined): string | undefined {
  const d = (raw?.payload as { _data?: Record<string, unknown> } | undefined)?._data;
  const pick = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return pick(d?.SenderPN) ?? pick(d?.Sender);
}

async function step(actions: IncidentAction[], type: string, target: string, fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    const bad = Array.isArray(r) ? (r as { ok?: boolean; error?: string }[]).find((x) => x && x.ok === false) : null;
    actions.push(bad ? { type, target, ok: false, error: bad.error ?? 'falhou' } : { type, target, ok: true });
  } catch (err) {
    actions.push({ type, target, ok: false, error: (err as Error).message.slice(0, 200) });
  }
}

const statusOf = (a: IncidentAction[]): IncidentStatus =>
  !a.length ? 'acted' : a.every((x) => x.ok) ? 'acted' : a.some((x) => x.ok) ? 'partial' : 'failed';

/** Reserva o incidente (dedup), aplica dry-run e loop guard, executa e fecha. */
async function incident(
  deps: SecDeps,
  c: Ctx,
  base: Omit<NewIncident, 'status' | 'campaignId' | 'groupId' | 'gid'>,
  limitKey: string,
  run: (actions: IncidentAction[]) => Promise<void>,
): Promise<string | null> {
  const limiter = deps.limiter ?? defaultLimiter;
  const dry = c.cfg.dryRun;
  const id = await deps.repo.claimIncident({
    ...base,
    status: dry ? 'dry_run' : 'acted',
    campaignId: c.campaign.id,
    groupId: c.group.id,
    gid: c.group.gid,
  });
  if (!id || dry) return id;
  // loop guard depois do dedup: cópias do mesmo evento (outras contas) não gastam a cota
  if (!limiter.take(limitKey)) {
    await deps.repo.finishIncident(id, { status: 'rate_limited', actions: [] });
    return id;
  }
  const actions: IncidentAction[] = [];
  await run(actions);
  await deps.repo.finishIncident(id, { status: statusOf(actions), actions });
  return id;
}

const defaultLimiter = new ReactionLimiter();

/**
 * O `announce` gravado vem da sincronização (até ~1 h de atraso): grupo aberto há pouco ainda consta fechado e todo
 * participante que escreve viraria violação. Antes de punir por "grupo fechado" confirma ao vivo; sem resposta clara, não age.
 */
async function closedNow(deps: SecDeps, c: Ctx, session: string, gid: string): Promise<boolean> {
  const acc = actingAccount(c, session);
  if (!acc) return true; // sem conta ninguém age mesmo: segue p/ registrar o incidente como falha
  try {
    return (await deps.engine.getGroup(acc.sessionName, gid)).announce === true;
  } catch {
    return false;
  }
}

// ── (a) mensagem ──────────────────────────────────────────────────

export async function onMessage(e: Extract<WaEvent, { kind: 'message.in' }>, deps: SecDeps): Promise<SecResult> {
  if (e.fromMe || !e.chatId.endsWith('@g.us')) return { handled: false, note: 'fora de grupo' };
  const c = await load(deps, e.chatId);
  if (!c) return { handled: false, note: 'grupo desconhecido' };
  if (!c.cfg.enabled) return { handled: false, note: 'anti-hacker desligado' };
  // a lista oficial casa por telefone: autor só com LID é resolvido antes de julgar
  const author = await resolveIdentity(deps.engine, actingAccount(c, e.session)?.sessionName, identityOf(e.from), e.from);
  const v = judgeMessage({
    author,
    allow: c.allow,
    closed: isClosed(c.group.settings, c.campaign.onlyAdminsSpeak),
    body: e.body,
    cfg: c.cfg,
  });
  if (!v.violation) return { handled: true, note: v.reason };
  if (v.reason === 'closed-group' && !(await closedNow(deps, c, e.session, e.chatId)))
    return { handled: true, note: 'grupo aberto ao vivo' };
  const id = await punishMessage(deps, c, {
    kind: 'message',
    session: e.session,
    chatId: e.chatId,
    messageId: e.id,
    authorJid: e.from,
    author,
    deleteIt: c.cfg.deleteNonAdminMessages,
    details: { reason: v.reason, matched: v.violation ? v.matched : undefined, body: e.body?.slice(0, 500) },
  });
  return { handled: true, note: `violação: ${v.reason}`, incidents: id ? [id] : [] };
}

/** Apaga a mensagem, remove o autor e bloqueia — mesma `dedup_key` p/ message.in e reação (1 ação por mensagem). */
async function punishMessage(
  deps: SecDeps,
  c: Ctx,
  m: {
    kind: 'message' | 'reaction';
    session: string;
    chatId: string;
    messageId: string;
    authorJid: string;
    author: Identity;
    deleteIt: boolean;
    details: Record<string, unknown>;
  },
): Promise<string | null> {
  const acc = actingAccount(c, m.session);
  const dedupKey = `msg:${m.chatId}:${m.messageId}`;
  // sem telefone não dá para conferir a lista oficial: só registra p/ revisão humana, nunca apaga/remove/bloqueia
  if (!m.author.number)
    return deps.repo.recordFinding({
      kind: m.kind,
      severity: 'warning',
      status: 'open',
      dedupKey,
      campaignId: c.campaign.id,
      groupId: c.group.id,
      gid: c.group.gid,
      waAccountId: acc?.id ?? null,
      who: m.author,
      messageId: m.messageId,
      details: { ...m.details, identity: 'número não identificado' },
    });
  return incident(
    deps,
    c,
    {
      kind: m.kind,
      severity: 'warning',
      dedupKey,
      waAccountId: acc?.id ?? null,
      who: m.author,
      messageId: m.messageId,
      details: m.details,
    },
    `${c.group.id}:message`,
    async (actions) => {
      if (!acc) return void actions.push({ type: 'conta', ok: false, error: 'nenhuma conta conectada' });
      if (m.deleteIt) {
        await step(actions, 'apagar-mensagem', m.messageId, () =>
          deps.engine.deleteMessage(acc.sessionName, m.chatId, m.messageId),
        );
        const del = actions.at(-1)!;
        if (!del.ok)
          deps.log?.(`[sec] motor não conseguiu apagar a mensagem ${m.messageId} em ${m.chatId}: ${del.error}`);
      }
      if (c.cfg.removeAuthor)
        await step(actions, 'remover-autor', label(m.author), () =>
          deps.engine.removeParticipants(acc.sessionName, m.chatId, [m.authorJid]),
        );
      await step(actions, 'bloquear', label(m.author), () =>
        deps.repo.block({
          campaign: c.campaign,
          who: m.author,
          name: `Hacker de mensagem ${label(m.author)}`,
          toAntiSpam: c.cfg.sendToAntiSpam,
        }),
      );
    },
  );
}

// ── reações ────────────────────────────────────────────────

/**
 * Reação a uma mensagem que as contas não receberam (golpista escreveu e o message.in não chegou): a reação revela o
 * id (e o autor) da mensagem → mesma regra do (a) sem o texto (só grupo fechado) → apaga no motor, remove e bloqueia.
 * Não apaga nada do banco. Motor sem "apagar" (ex. GOWS 501) → passo com erro no incidente + aviso no log.
 */
export async function onReaction(
  e: Extract<WaEvent, { kind: 'message.reaction' }>,
  deps: SecDeps,
): Promise<SecResult> {
  if (!e.chatId.endsWith('@g.us') || !e.messageId) return { handled: false, note: 'fora de grupo' };
  if (!e.emoji) return { handled: true, note: 'reação removida' };
  const { fromMe, author: authorJid } = messageAuthor(e.messageId);
  if (fromMe) return { handled: true, note: 'mensagem nossa' };
  if (!authorJid) return { handled: true, note: 'autor desconhecido' };
  const c = await load(deps, e.chatId);
  if (!c) return { handled: false, note: 'grupo desconhecido' };
  // só reação da equipe (allowlist) revela golpe — senão qualquer membro derrubaria outro reagindo à mensagem dele.
  // Membro da equipe sem LID salvo, reagindo pelo LID, é ignorado (falha segura).
  if (!c.allow.has(identityOf(e.from))) return { handled: true, note: 'reator não é da equipe' };
  if (!c.cfg.enabled) return { handled: false, note: 'anti-hacker desligado' };
  if (!c.cfg.reactionProtection) return { handled: true, note: 'proteção por reações desligada' };
  const author = await resolveIdentity(deps.engine, actingAccount(c, e.session)?.sessionName, identityOf(authorJid), authorJid);
  const v = judgeMessage({
    author,
    allow: c.allow,
    closed: isClosed(c.group.settings, c.campaign.onlyAdminsSpeak),
    cfg: c.cfg,
  });
  if (!v.violation) return { handled: true, note: v.reason };
  if (v.reason === 'closed-group' && !(await closedNow(deps, c, e.session, e.chatId)))
    return { handled: true, note: 'grupo aberto ao vivo' };
  const id = await punishMessage(deps, c, {
    kind: 'reaction',
    session: e.session,
    chatId: e.chatId,
    messageId: e.messageId,
    authorJid,
    author,
    deleteIt: c.cfg.deleteNonAdminMessages,
    details: { reason: v.reason, reactor: label(identityOf(e.from)), emoji: e.emoji },
  });
  return { handled: true, note: `violação: ${v.reason}`, incidents: id ? [id] : [] };
}

// ── (b)(d)(e) participantes ───────────────────────────────────────

export async function onParticipants(
  e: Extract<WaEvent, { kind: 'group.participants' }>,
  deps: SecDeps,
  raw?: WahaWebhook | null,
): Promise<SecResult> {
  const c = await load(deps, e.gid);
  if (!c) return { handled: false, note: 'grupo desconhecido' };
  const actorJid = e.actor ?? rawActor(raw);
  const session = actingAccount(c, e.session)?.sessionName;
  const actor = actorJid ? await resolveIdentity(deps.engine, session, identityOf(actorJid), actorJid) : null;
  const actorTrusted = !!actor && c.allow.has(actor);
  const out: string[] = [];
  const bucket = Math.floor(e.ts / 60_000);

  if (e.action === 'add') {
    const blocked = new Set<EventParticipant>();
    if (c.cfg.enabled && c.cfg.removeBlockedOnJoin && c.campaign.autoDenyBlocked) {
      for (const p of e.participants) {
        const entry = identityOf(p.jid, lidJid(p.lid));
        if (!(await deps.repo.isBlocked(entry, c.campaign.id))) continue;
        const who = await resolveIdentity(deps.engine, session, entry, p.jid);
        if (c.allow.has(who)) continue;
        blocked.add(p);
        const acc = actingAccount(c, e.session);
        const id = await incident(
          deps,
          c,
          {
            kind: 'blocked_join',
            severity: 'info',
            dedupKey: `join:${e.gid}:${label(who)}:${bucket}`,
            waAccountId: acc?.id ?? null,
            who,
            actor: actorJid,
          },
          `${c.group.id}:join`,
          async (actions) => {
            if (!acc) return void actions.push({ type: 'conta', ok: false, error: 'nenhuma conta conectada' });
            await step(actions, 'remover-bloqueado', label(who), () =>
              deps.engine.removeParticipants(acc.sessionName, e.gid, [p.jid]),
            );
          },
        );
        if (id) out.push(id);
      }
    }
    out.push(...(await impostorsOnJoin(deps, c, e, actorJid, blocked)));
    return { handled: true, incidents: out };
  }

  if (!c.cfg.enabled || !c.cfg.protectAdmins) return { handled: true, note: 'proteção de admins desligada' };

  if (e.action === 'promote') {
    const rogue = (
      await Promise.all(
        e.participants.map(async (p) => ({
          p,
          who: await resolveIdentity(deps.engine, session, identityOf(p.jid, lidJid(p.lid)), p.jid),
        })),
      )
    ).filter(({ who }) => !c.allow.has(who));
    if (!rogue.length) return { handled: true, note: 'promoção autorizada' };
    const acc = actingAccount(c, e.session);
    const targets = [...rogue.map((r) => ({ jid: r.p.jid, who: r.who }))];
    // autor sem telefone não dá para conferir a lista oficial: não é punido
    if (actor?.number && actorJid && !actorTrusted && !targets.some((t) => t.jid === actorJid))
      targets.push({ jid: actorJid, who: actor });
    const id = await incident(
      deps,
      c,
      {
        kind: 'promote',
        severity: 'critical',
        dedupKey: `promote:${e.gid}:${rogue.map((r) => label(r.who)).join(',')}:${bucket}`,
        waAccountId: acc?.id ?? null,
        who: rogue[0]!.who,
        actor: actorJid,
        details: { promoted: rogue.map((r) => label(r.who)), actorTrusted },
      },
      `${c.group.id}:promote`,
      async (actions) => {
        if (!acc) return void actions.push({ type: 'conta', ok: false, error: 'nenhuma conta conectada' });
        const jids = targets.map((t) => t.jid);
        await step(actions, 'rebaixar', jids.join(','), () => deps.engine.demote(acc.sessionName, e.gid, jids));
        // só remove quem tem telefone conferido; sem ele fica só o rebaixamento
        const sure = targets.filter((t) => t.who.number).map((t) => t.jid);
        if (c.cfg.removeAuthor && sure.length)
          await step(actions, 'remover', sure.join(','), () =>
            deps.engine.removeParticipants(acc.sessionName, e.gid, sure),
          );
      },
    );
    if (id) {
      out.push(id);
      await alert(deps, c, 'security.unauthorized-promote', acc, {
        promoted: rogue.map((r) => label(r.who)),
        actor: actorJid ?? null,
      });
    }
    return { handled: true, note: 'promoção não autorizada', incidents: out };
  }

  // demote / remove de conta da campanha
  const lost = e.participants
    .map((p) => ({ p, who: identityOf(p.jid, lidJid(p.lid)) }))
    .filter(({ who }) => c.ours.has(who));
  if (!lost.length) return { handled: true };
  if (actorTrusted) return { handled: true, note: 'alteração feita por admin autorizado' };
  const acc = actingAccount(
    c,
    e.session,
    lost.map((l) => l.who),
  );
  const id = await incident(
    deps,
    c,
    {
      kind: 'admin_lost',
      severity: 'critical',
      dedupKey: `lost:${e.gid}:${e.action}:${lost.map((l) => label(l.who)).join(',')}:${bucket}`,
      waAccountId: acc?.id ?? null,
      who: lost[0]!.who,
      actor: actorJid,
      details: { action: e.action, accounts: lost.map((l) => label(l.who)) },
    },
    `${c.group.id}:lost`,
    async (actions) => {
      if (!acc) return void actions.push({ type: 'conta', ok: false, error: 'nenhuma outra conta admin conectada' });
      const jids = lost.map((l) => jidOf(l.who, l.p.jid));
      if (e.action === 'remove')
        await step(actions, 're-adicionar', jids.join(','), () => deps.engine.addParticipants(acc.sessionName, e.gid, jids));
      await step(actions, 're-promover', jids.join(','), () => deps.engine.promote(acc.sessionName, e.gid, jids));
      // autor só com LID: sem telefone não dá para conferir a lista oficial, então não pune (a conta nossa já foi recolocada)
      if (actor && actorJid && !actor.number && !c.ours.has(actor))
        actions.push({ type: 'verificar-autor', ok: false, error: 'sem telefone para conferir a lista oficial' });
      else if (actor && actorJid && !c.ours.has(actor)) {
        await step(actions, 'rebaixar-autor', actorJid, () => deps.engine.demote(acc.sessionName, e.gid, [actorJid]));
        if (c.cfg.removeAuthor)
          await step(actions, 'remover-autor', actorJid, () =>
            deps.engine.removeParticipants(acc.sessionName, e.gid, [actorJid]),
          );
      }
    },
  );
  if (id) {
    out.push(id);
    await alert(deps, c, 'security.admin-lost', acc, {
      action: e.action,
      accounts: lost.map((l) => label(l.who)),
      actor: actorJid ?? null,
    });
  }
  return { handled: true, note: 'conta da campanha perdeu admin', incidents: out };
}

/**
 * Impostor na entrada: foto parecida com a arte oficial ou nome de "Suporte". Só a cópia do evento da conta que age
 * é processada (1 consulta por entrada, mesmo com 3 chips no grupo) e quem consulta é `lookupSession`; `dedupKey` com bucket de 1 min: o mesmo evento nos 3 chips
 * vira 1 incidente, e uma nova entrada depois é avaliada de novo. Erro numa consulta vale "sem dados" (nunca remove) e não impede os próximos participantes.
 */
async function impostorsOnJoin(
  deps: SecDeps,
  c: Ctx,
  e: Extract<WaEvent, { kind: 'group.participants' }>,
  actorJid: string | undefined,
  skip: Set<EventParticipant>,
): Promise<string[]> {
  const out: string[] = [];
  const eng = deps.engine;
  const getPicture = eng.getProfilePicture?.bind(eng);
  if (!c.cfg.enabled || c.cfg.impersonation === 'off' || !getPicture) return out;
  const bucket = Math.floor(e.ts / 60_000);
  const acc = actingAccount(c, e.session);
  if (!acc || acc.sessionName !== e.session) return out;
  const limiter = deps.profileLimiter ?? defaultProfileLimiter;
  // contas do painel (da campanha ou não) nem são consultadas; se a lista falhar, ninguém é consultado
  const agency = new IdentitySet();
  try {
    for (const a of await deps.repo.agencyAccounts()) agency.add(a);
  } catch (err) {
    deps.log?.(`[sec] contas do painel em ${e.gid}: ${(err as Error).message}`);
    return out;
  }
  const load = deps.loadPhoto ?? ((url: string) => fetchPhoto(url));
  const safe = async <T>(fn: () => Promise<T | null | undefined> | undefined): Promise<T | null> => {
    try {
      return (await fn()) ?? null;
    } catch {
      return null;
    }
  };
  let checked = 0;
  let skipped = 0;
  for (const p of e.participants) {
    const who = identityOf(p.jid, lidJid(p.lid));
    if (skip.has(p) || c.allow.has(who) || agency.has(who)) continue;
    // quem consulta: espiã da vez (rodízio); sem espiã no ar ou teto estourado, fica para a análise diária
    const look = lookupSession(c, acc.sessionName);
    if (!look || !limiter.take(look)) {
      skipped++;
      continue;
    }
    checked++;
    try {
      const name = await safe(() => eng.getContactName?.(look, p.jid));
      const url = await safe(() => getPicture(look, p.jid));
      const bytes = url ? await safe(() => load(url)) : null;
      const v = judgeProfile({ name, photoHash: bytes ? await photoHash(bytes) : null, cfg: c.cfg });
      if (v.match === null) continue;
      const base = {
        kind: 'scan.impersonator' as const,
        severity: v.match === 'photo' ? ('critical' as const) : ('warning' as const),
        dedupKey: `impostor:${e.gid}:${label(who)}:${bucket}`,
        waAccountId: acc.id,
        who,
        actor: actorJid,
      };
      // quem entra só com LID precisa do telefone resolvido
      const phone = who.number ?? (await safe(() => eng.phoneOfLid?.(look, lidJid(who.lid) ?? p.jid)));
      if (phone && !who.number) base.who = identityOf(phone, lidJid(who.lid)); // o achado sempre traz o número
      const details = { reason: v.match, matched: v.matched, profileName: name?.slice(0, 100) ?? null, jid: p.jid };
      let id: string | null;
      // nome só age sozinho com a caixa "remover por nome" ligada (risco: pessoa real com nome tipo "Adm")
      if (c.cfg.impersonation === 'auto' && (v.match === 'photo' || c.cfg.impersonationRemoveByName)) {
        id = await incident(
          deps,
          c,
          { ...base, details: { ...details, ...(v.match === 'photo' ? { distance: v.distance } : {}) } },
          `${c.group.id}:impostor`,
          async (actions) => {
            // remover só com a trava central (confirmação positiva do grupo, fora de admin e da lista oficial)
            const check = await confirmRemovable({
              engine: eng,
              session: acc.sessionName,
              gid: e.gid,
              who,
              allow: c.allow,
              repo: deps.repo,
            });
            if (!check.ok)
              return void actions.push({
                type: 'verificar-admin',
                target: label(who),
                ok: false,
                error: check.reason,
              });
            await step(actions, 'remover-impostor', label(who), () =>
              eng.removeParticipants(acc.sessionName, e.gid, [check.jid]),
            );
            await step(actions, 'bloquear', label(who), () =>
              deps.repo.block({
                campaign: c.campaign,
                who,
                name: `Impostor ${label(who)}`,
                toAntiSpam: c.cfg.sendToAntiSpam,
              }),
            );
          },
        );
      } else {
        id = await deps.repo.recordFinding({
          ...base,
          status: 'open',
          campaignId: c.campaign.id,
          groupId: c.group.id,
          gid: c.group.gid,
          details,
        });
      }
      if (id) out.push(id);
    } catch (err) {
      deps.log?.(`[sec] impostor ${label(who)} em ${e.gid}: ${(err as Error).message}`);
    }
  }
  if (checked || skipped)
    deps.log?.(`[sec] entrada em ${e.gid}: ${checked} conferido(s), ${skipped} pulado(s) (teto ou sem espiã no ar), ${out.length} achado(s)`);
  return out;
}

const defaultProfileLimiter = new ReactionLimiter(30, 60_000);

// ── (c) nome/descrição/convite ────────────────────────────────────

export async function onGroupUpdate(
  e: Extract<WaEvent, { kind: 'group.update' }>,
  deps: SecDeps,
  raw?: WahaWebhook | null,
): Promise<SecResult> {
  const c = await load(deps, e.gid);
  if (!c) return { handled: false, note: 'grupo desconhecido' };
  if (!c.cfg.enabled) return { handled: false, note: 'anti-hacker desligado', accepted: true };
  const description = e.description ?? topicOf(raw);
  const changed = changedFields({ ...e, description }, c.group);
  if (!Object.keys(changed).length) return { handled: true, note: 'sem mudança', accepted: true };
  const actorJid = rawActor(raw);
  if (!actorJid) return { handled: true, note: 'autor desconhecido — não reverte' };
  const acc = actingAccount(c, e.session);
  const actor = await resolveIdentity(deps.engine, acc?.sessionName, identityOf(actorJid), actorJid);
  if (c.allow.has(actor)) return { handled: true, note: 'alteração autorizada', accepted: true };
  const revert = c.cfg.revertNameDescriptionChange;
  const id = await incident(
    deps,
    c,
    {
      kind: 'group_update',
      severity: changed.inviteCode ? 'critical' : 'warning',
      // minuto do evento: absorve o reenvio do webhook e as cópias nos outros chips, mas a mesma ofensa repetida depois vale de novo
      dedupKey: `update:${e.gid}:${Math.floor(e.ts / 60_000)}:${JSON.stringify(changed)}`,
      waAccountId: acc?.id ?? null,
      who: actor,
      actor: actorJid,
      details: { changed, expected: { name: c.group.name, description: c.group.description }, revert },
    },
    `${c.group.id}:update`,
    async (actions) => {
      if (!revert || !acc) {
        if (!acc) actions.push({ type: 'conta', ok: false, error: 'nenhuma conta conectada' });
        return;
      }
      if (changed.subject !== undefined)
        await step(actions, 'reverter-nome', c.group.name, () =>
          deps.engine.setSubject(acc.sessionName, e.gid, c.group.name),
        );
      if (changed.description !== undefined)
        await step(actions, 'reverter-descricao', '', () =>
          deps.engine.setDescription(acc.sessionName, e.gid, c.group.description ?? ''),
        );
      if (c.cfg.removeAuthor && actor.number && !c.ours.has(actor))
        await step(actions, 'rebaixar-e-remover-autor', actorJid, async () => {
          await deps.engine.demote(acc.sessionName, e.gid, [actorJid]);
          return deps.engine.removeParticipants(acc.sessionName, e.gid, [actorJid]);
        });
    },
  );
  if (id && changed.inviteCode)
    await alert(deps, c, 'security.invite-changed', acc, { actor: actorJid, note: 'GOWS não revoga: rotacionar grupo' });
  return { handled: true, note: 'alteração não autorizada', incidents: id ? [id] : [] };
}

export function topicOf(raw?: WahaWebhook | null): string | undefined {
  const t = (raw?.payload as { _data?: { Topic?: { Topic?: unknown } | null } } | undefined)?._data?.Topic;
  return t && typeof t.Topic === 'string' ? t.Topic : undefined;
}

async function alert(
  deps: SecDeps,
  c: Ctx,
  type: string,
  acc: SecAccount | null,
  data: Record<string, unknown>,
) {
  if (!c.cfg.alertChannels.length) return;
  try {
    await deps.repo.alert({
      type,
      campaignId: c.campaign.id,
      groupId: c.group.id,
      waAccountId: acc?.id ?? null,
      data: { ...data, gid: c.group.gid, group: c.group.name, channels: c.cfg.alertChannels },
    });
  } catch (err) {
    deps.log?.(`[sec] alerta ${type} falhou: ${(err as Error).message}`);
  }
}

/** Fábrica p/ o roteador (`WaEventHandlers` parcial). Interruptores globais com cache de 60 s. */
export function createSecHandlers(input: SecDeps) {
  const deps: SecDeps = { ...input, settings: input.settings ?? cachedSettings(() => input.repo.globalSettings()) };
  return {
    'message.in': (e: Extract<WaEvent, { kind: 'message.in' }>) => onMessage(e, deps),
    'message.reaction': (e: Extract<WaEvent, { kind: 'message.reaction' }>) => onReaction(e, deps),
    'group.participants': (e: Extract<WaEvent, { kind: 'group.participants' }>, ctx?: { raw: WahaWebhook | null }) =>
      onParticipants(e, deps, ctx?.raw),
    'group.update': (e: Extract<WaEvent, { kind: 'group.update' }>, ctx?: { raw: WahaWebhook | null }) =>
      onGroupUpdate(e, deps, ctx?.raw),
  };
}
