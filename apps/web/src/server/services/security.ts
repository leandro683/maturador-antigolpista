import 'server-only';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { headers } from 'next/headers';
import { actions as actionsTable, campaigns, waAccounts } from '@mag/db/schema';
import type { CsvEntry } from '@mag/module-blacklist/csv';
import { normalizeEntry } from '@mag/module-blacklist/normalize';
import { listAdminNumbers } from '@mag/module-blacklist/service';
import {
  accountCollaborators,
  actOnFindings,
  addCollaborator,
  antiSpamOptIns,
  campaignSecurity,
  cancelScan,
  ensureVerifyPage,
  fetchPhoto,
  FINDING_OPS,
  importCollaborators,
  incidentsByNumber,
  incidentsCsv,
  INCIDENT_KINDS,
  jidOf,
  listCollaborators,
  listIncidents,
  listScans,
  openIncidentCount,
  phoneResolvingEngine,
  photoHash,
  readSecuritySettings,
  removeCollaborators,
  resolveIncidents,
  saveAntiHacker,
  saveSecuritySettings,
  scanCreator,
  SEC_SCAN_QUEUE,
  SECURITY_SCAN_TYPE,
  setAntiSpamOptIn,
  setVerifyPage,
  startScan,
  verificationCounts,
  verificationHistory,
  verifyNumber,
  type AntiHackerInput,
  type FindingOp,
  type IncidentFilter,
  type IncidentKind,
  type SecuritySettings,
} from '@mag/module-security';
import { brPhoneVariants } from '@mag/shared/phone';
import type { WaEngine } from '@mag/wa-engine';
import { getSession, requireAdmin } from '@/lib/auth';
import { zonedDay } from '@/lib/zoned-day';
import { serverDb } from '../db';
import { trustedClientIp } from '../client-ip';
import { serverEngine } from '../engine';
import { serverQueue } from '../queues';

/** Segurança no painel: incidentes (/seguranca), config anti-golpista e colaboradores da operação. Só o dono (sessão válida). */

export type Result<T = null> = { ok: true; data: T } | { ok: false; error: string };
// sem redirect: o erro vira mensagem na tela (o redirect do requireAdmin seria engolido pelo catch)
async function run<T>(fn: (userId: string) => Promise<T>): Promise<Result<T>> {
  try {
    const { user: u } = await getSession();
    if (!u) throw new Error('sem permissão para esta ação');
    return { ok: true, data: await fn(u.id) };
  } catch (e) {
    const issues = (e as { issues?: { message: string }[] })?.issues;
    if (issues?.[0]) return { ok: false, error: issues[0].message };
    // mensagem própria (Error simples, escrita em português por quem lançou) vai à tela; erro de banco/fila/rede não
    // (o ioredis lança Error simples, sem `code`, quando o Redis está fora: "Stream isn't writeable…")
    if (
      e instanceof Error &&
      e.name === 'Error' &&
      typeof (e as { code?: unknown }).code !== 'string' &&
      !('query' in e) &&
      !/stream|redis|socket|econn|offline queue|connection is closed/i.test(e.message)
    )
      return { ok: false, error: e.message };
    console.error('[seguranca]', e);
    return { ok: false, error: 'Não foi possível concluir agora. Tente de novo em instantes.' };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const day = (s: string, end = false) => zonedDay(s, end);
/** Operação recebida do navegador: só UUID entra no banco. */
const campaignOf = (id: string) => {
  if (!UUID.test(id)) throw new Error('operação inválida');
  return id;
};

export function incidentFilter(sp: SP): IncidentFilter & { raw: Record<string, string> } {
  const campaignId = UUID.test(one(sp.campanha)) ? one(sp.campanha) : undefined;
  const kind = (INCIDENT_KINDS as readonly string[]).includes(one(sp.tipo)) ? (one(sp.tipo) as IncidentKind) : undefined;
  const scanId = UUID.test(one(sp.analise)) ? one(sp.analise) : undefined;
  return {
    campaignId,
    kind,
    scanId,
    from: day(one(sp.de)),
    to: day(one(sp.ate), true),
    open: one(sp.abertos) === '1',
    page: Math.max(1, Number(one(sp.pagina)) || 1),
    pageSize: 25,
    raw: {
      campanha: campaignId ?? '',
      tipo: kind ?? '',
      de: one(sp.de),
      ate: one(sp.ate),
      abertos: one(sp.abertos),
      analise: scanId ?? '',
    },
  };
}

export async function securityPage(sp: SP) {
  await requireAdmin();
  const db = serverDb();
  const f = incidentFilter(sp);
  const [list, byNumber, open, camps, optIns, admins, scans, settings] = await Promise.all([
    listIncidents(db, f),
    incidentsByNumber(db, { ...f, page: undefined }),
    openIncidentCount(db),
    db
      .select({ id: campaigns.id, name: campaigns.name, antiHacker: campaigns.antiHacker })
      .from(campaigns)
      .orderBy(asc(campaigns.name)),
    antiSpamOptIns(db),
    listAdminNumbers(db),
    listScans(db, { campaignId: f.campaignId, limit: 5 }),
    readSecuritySettings(db),
  ]);
  return {
    filter: f,
    list,
    byNumber,
    open,
    campaigns: camps,
    optIns,
    adminCount: admins.length,
    scans,
    settings,
    engineReady: !!serverEngine(),
  };
}

export async function exportIncidents(sp: SP): Promise<Result<string>> {
  return run(async () => {
    const f = incidentFilter(sp);
    const { rows } = await listIncidents(serverDb(), { ...f, page: 1, pageSize: 500 });
    return incidentsCsv(rows);
  });
}

export const resolve = (ids: string[], status: 'ignored' | 'reverted') =>
  run((by) => resolveIncidents(serverDb(), ids.filter((i) => UUID.test(i)), status, by));

export const optIn = (campaignId: string, enabled: boolean) =>
  run(async (by) => {
    await setAntiSpamOptIn(serverDb(), campaignOf(campaignId), enabled, by);
    return null;
  });

// ── operação ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function campaignSecurityPage(campaignId: string) {
  await requireAdmin();
  if (!UUID.test(campaignId)) return null;
  const db = serverDb();
  const sec = await campaignSecurity(db, campaignId);
  if (!sec) return null;
  const [admins, open, scans] = await Promise.all([
    listAdminNumbers(db),
    openIncidentCount(db, campaignId),
    listScans(db, { campaignId, limit: 3 }),
  ]);
  return { ...sec, admins: admins.map((a) => ({ id: a.id, number: a.number, label: a.label })), open, scans };
}

export const saveAntiHackerConfig = (campaignId: string, input: AntiHackerInput & { antiSpamOptIn?: boolean }) =>
  run(async (by) => {
    await saveAntiHacker(serverDb(), campaignOf(campaignId), input, by);
    return null;
  });

export async function collaboratorsPage(campaignId: string) {
  await requireAdmin();
  if (!UUID.test(campaignId)) throw new Error('operação inválida');
  const db = serverDb();
  const [list, accounts, history, counts] = await Promise.all([
    listCollaborators(db, campaignId),
    accountCollaborators(db, campaignId),
    verificationHistory(db, campaignId, { limit: 30 }),
    verificationCounts(db, campaignId),
  ]);
  return { list, accounts, history, counts };
}

export const addCollab = (campaignId: string, value: string, name: string, kind: 'phone' | 'lid') =>
  run(async () => {
    await addCollaborator(serverDb(), campaignOf(campaignId), { value, name, kind });
    return null;
  });

/** Entradas vêm parseadas do navegador; renormaliza no servidor. */
export const importCollabs = (campaignId: string, entries: CsvEntry[]) =>
  run(async () => {
    const clean: CsvEntry[] = [];
    for (const e of entries.slice(0, 5000)) {
      const k = normalizeEntry(e.lid ? `${e.lid}@lid` : (e.number ?? ''));
      if (k) clean.push({ ...k, name: e.name?.slice(0, 80) });
    }
    return importCollaborators(serverDb(), campaignOf(campaignId), clean);
  });

export const removeCollabs = (campaignId: string, ids: string[]) =>
  run(async () => {
    await removeCollaborators(serverDb(), campaignOf(campaignId), ids.filter((i) => UUID.test(i)));
    return null;
  });

export const verify = (campaignId: string, query: string) =>
  run(async (by) => {
    const r = await verifyNumber(serverDb(), campaignOf(campaignId), query, { checkedBy: by, channel: 'painel' });
    return { valid: r.valid, result: r.result, match: r.match };
  });

// ── Analisar grupos ──────────────────────────────────────

let resolving: { base: WaEngine; engine: WaEngine } | null = null;
const findingEngine = () => {
  const base = serverEngine();
  if (!base) return undefined;
  if (resolving?.base !== base) resolving = { base, engine: phoneResolvingEngine(base, serverDb()) };
  return resolving.engine;
};

/** Cria a análise (`security-scan`: pai + 1 filho por conta, na fila `sec-scan`) p/ todos os grupos da operação. Nada é feito no WhatsApp além de ler. */
export const startGroupScan = (campaignId: string, messageLimit: number, checkProfiles = false) =>
  run(async (by) => {
    if (!UUID.test(campaignId)) throw new Error('escolha uma operação');
    const db = serverDb();
    const queue = serverQueue(SEC_SCAN_QUEUE);
    const create = scanCreator(db, async (childId) => {
      await queue.add('scan', { childId });
    });
    return startScan(db, create, campaignId, { messageLimit, checkProfiles }, by);
  });

/** Cancela a análise (o worker para entre um grupo e outro). Só aceita análises `security-scan`. */
export const cancelGroupScan = (scanId: string) =>
  run(async () => {
    if (!UUID.test(scanId)) throw new Error('análise inválida');
    const db = serverDb();
    const [a] = await db
      .select({ id: actionsTable.id })
      .from(actionsTable)
      .where(and(eq(actionsTable.id, scanId), eq(actionsTable.type, SECURITY_SCAN_TYPE)))
      .limit(1);
    if (!a) throw new Error('análise não encontrada');
    await cancelScan(db, scanId);
    return null;
  });

/** Decisão do operador sobre achados em aberto (por linha ou em lote, até 100 por vez). */
export const actOnScanFindings = (ids: string[], op: FindingOp, block = false) =>
  run(async (by) => {
    if (!(FINDING_OPS as readonly string[]).includes(op)) throw new Error('ação inválida');
    return actOnFindings({ db: serverDb(), engine: findingEngine() }, ids.filter((i) => UUID.test(i)), op, by, block && op === 'remove');
  });

// ── anti-impostor: foto de referência ─────────────────────────────

const REF_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const REF_IMAGE_MAX = 1024 * 1024;
const WORKING_STATUS = ['active', 'connected'];

/** A foto não é guardada (shortcut: sem miniatura na tela, só rótulo + hash; guardar a imagem se pedirem prévia). */
async function hashOrThrow(bytes: Uint8Array) {
  const hash = await photoHash(bytes);
  if (!hash) throw new Error('Não consegui ler essa imagem. Tente outro arquivo.');
  return { hash };
}

/** Hash da arte enviada pelo operador (campo `file`; png/jpeg/webp, até 1 MB). */
export const impersonationPhotoFromFile = (form: FormData) =>
  run(async () => {
    const f = form.get('file');
    if (!(f instanceof File) || f.size === 0) throw new Error('Escolha uma imagem.');
    if (!REF_IMAGE_TYPES.includes(f.type)) throw new Error('Use uma imagem PNG, JPG ou WebP.');
    if (f.size > REF_IMAGE_MAX) throw new Error('A imagem passa de 1 MB.');
    return hashOrThrow(new Uint8Array(await f.arrayBuffer()));
  });

/** Hash da foto de perfil de um número, lida pela primeira conta conectada da operação. */
export const impersonationPhotoFromNumber = (campaignId: string, phone: string) =>
  run(async () => {
    if (!UUID.test(campaignId)) throw new Error('escolha uma operação');
    const number = normalizeEntry(phone, 'phone')?.number;
    if (!number) throw new Error('Número inválido.');
    const db = serverDb();
    const [c] = await db.select({ ids: campaigns.accountIds }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    const accs = c?.ids?.length
      ? await db
          .select({ sessionName: waAccounts.sessionName, status: waAccounts.status })
          .from(waAccounts)
          .where(inArray(waAccounts.id, c.ids))
          .orderBy(asc(waAccounts.position))
      : [];
    const acc = accs.find((a) => WORKING_STATUS.includes(a.status));
    if (!acc) throw new Error('Nenhuma conta conectada nesta operação.');
    const eng = findingEngine();
    if (!eng?.getProfilePicture) throw new Error('O WhatsApp não está configurado neste servidor.');
    // conta antiga tem JID sem o 9º dígito: com o 9 o motor devolve "sem foto"
    let url: string | null | undefined;
    for (const n of brPhoneVariants(number)) if ((url = await eng.getProfilePicture(acc.sessionName, jidOf({ number: n, lid: null })))) break;
    const bytes = url ? await fetchPhoto(url) : null;
    if (!bytes) throw new Error('Esse número não tem foto visível.');
    return hashOrThrow(bytes);
  });

// ── Página pública de verificação ──────────────────────────

/** Página pública da operação (criada na 1ª visita à aba, desligada até o operador ligar). */
export async function verifyPageInfo(campaignId: string) {
  await requireAdmin();
  if (!UUID.test(campaignId)) throw new Error('operação inválida');
  const p = await ensureVerifyPage(serverDb(), campaignId);
  return { slug: p.slug, enabled: p.enabled, eventName: p.eventName };
}

export const saveVerifyPage = (campaignId: string, input: { enabled: boolean; eventName: string }) =>
  run(async (by) => {
    if (!UUID.test(campaignId)) throw new Error('operação inválida');
    await setVerifyPage(serverDb(), campaignId, { enabled: !!input.enabled, eventName: input.eventName }, by);
    return null;
  });

// ── Interruptores globais ──────────────────────────────────────────────

export const saveGlobalSecurity = (patch: Partial<SecuritySettings>) =>
  run(async (by) => {
    const clean: Partial<SecuritySettings> = {};
    if (typeof patch.antiSpamAssociatedOnly === 'boolean') clean.antiSpamAssociatedOnly = patch.antiSpamAssociatedOnly;
    if (typeof patch.sharedBlocklistAllCampaigns === 'boolean')
      clean.sharedBlocklistAllCampaigns = patch.sharedBlocklistAllCampaigns;
    return saveSecuritySettings(serverDb(), clean, by, trustedClientIp(await headers()));
  });
