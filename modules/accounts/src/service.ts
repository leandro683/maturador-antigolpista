import { randomBytes, randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { waAccounts } from '@mag/db/schema';
import { WahaHttpError, type WaEngine, type WaEvent } from '@mag/wa-engine';
import { onEngineStatus, type ConnPatch, type ConnSnapshot } from './connection';
import { normalizeRolePolicy, type AccountRole } from './role-policy';
import { isConnected } from './status';

export type AccountRow = {
  id: string;
  name: string;
  status: string;
  jid: string | null;
  sessionName: string;
  rolePolicy: unknown;
};

export class AccountNotFoundError extends Error {
  constructor(id: string) {
    super(`conta não encontrada: ${id}`);
    this.name = 'AccountNotFoundError';
  }
}

type Row = typeof waAccounts.$inferSelect;

const toRow = (r: Row): AccountRow => ({
  id: r.id,
  name: r.name,
  status: r.status,
  jid: r.jid,
  sessionName: r.sessionName,
  rolePolicy: r.rolePolicy,
});

const snapshot = (a: Row): ConnSnapshot => ({
  status: a.status,
  qrAttempt: a.qrAttempt,
  isAuthenticated: a.isAuthenticated,
  reachoutTimelock: a.reachoutTimelock,
  whatsappSuspension: a.whatsappSuspension,
});

/** Sessão que não existe mais no engine (404 do WAHA ou o texto do engine em memória). */
const sessionGone = (e: unknown) => (e instanceof WahaHttpError && e.status === 404) || /inexistente|not found/i.test((e as Error)?.message ?? '');

export function createAccountsService(
  db: Db,
  engine: WaEngine,
  opts: { log?: (message: string, error?: unknown) => void } = {},
) {
  const log = opts.log ?? ((m: string, e?: unknown) => console.warn(m, e));
  const must = async (id: string): Promise<Row> => {
    const [r] = await db.select().from(waAccounts).where(eq(waAccounts.id, id));
    if (!r) throw new AccountNotFoundError(id);
    return r;
  };
  const patch = async (id: string, p: ConnPatch & { jid?: string | null; lid?: string | null }) => {
    await db.update(waAccounts).set({ ...p, updatedAt: new Date() }).where(eq(waAccounts.id, id));
  };
  /** Falha do WAHA não trava o resto (a conta já mudou de estado), mas fica no log. Devolve o erro, se houve. */
  const tryEngine = async (op: string, session: string, fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      await fn();
      return undefined;
    } catch (e) {
      if (!sessionGone(e)) log(`[accounts] ${op} ${session}`, e);
      return e ?? new Error(op);
    }
  };

  /** Número e LID da conta vêm do perfil do engine; resposta sem eles nunca apaga o que já está guardado. */
  async function syncProfile(a: Row) {
    await tryEngine('ler perfil', a.sessionName, async () => {
      const me = await engine.getMe(a.sessionName);
      const found: { jid?: string; lid?: string } = {};
      if (me.jid) found.jid = me.jid;
      if (me.lid) found.lid = me.lid;
      if (!me.jid) log(`[accounts] perfil sem número ${a.sessionName}`);
      if (Object.keys(found).length) await patch(a.id, found);
    });
  }

  /** Aplica o status que o WAHA informou (evento ou leitura direta) e roda os efeitos no engine. */
  async function applyStatus(a: Row, status: string, reason: string | undefined, now: Date) {
    const t = onEngineStatus(snapshot(a), status, reason, now);
    if (t.changed) await patch(a.id, t.patch);
    for (const e of t.effects) {
      if (e.type === 'stop') await tryEngine('parar sessão', a.sessionName, () => engine.stopSession(a.sessionName));
      if (e.type === 'restart') {
        await tryEngine('parar sessão', a.sessionName, () => engine.stopSession(a.sessionName));
        await tryEngine('iniciar sessão', a.sessionName, () => engine.startSession(a.sessionName));
      }
      if (e.type === 'sync_profile') await syncProfile(a);
      // outbox/alert: sem fila de saída, não há o que gravar
    }
    // conectada e ainda sem número (a leitura do perfil falhou antes): tenta de novo a cada evento/consulta
    if (status === 'WORKING' && !a.jid && !t.effects.some((e) => e.type === 'sync_profile')) await syncProfile(a);
    return t;
  }

  return {
    async list(): Promise<AccountRow[]> {
      const rows = await db.select().from(waAccounts).orderBy(asc(waAccounts.position), asc(waAccounts.createdAt));
      return rows.map(toRow);
    },

    async create(input: { name: string }): Promise<AccountRow> {
      const name = input.name?.trim();
      if (!name) throw new Error('Informe o nome da conta.');
      const [r] = await db
        .insert(waAccounts)
        .values({ id: randomUUID(), name, sessionName: `mag_${randomBytes(4).toString('hex')}` })
        .returning();
      return toRow(r!);
    },

    /** Conectar / novo ciclo de QR: zera tentativas e (re)inicia a sessão no WAHA. */
    async connect(id: string): Promise<void> {
      const a = await must(id);
      if ((a.whatsappSuspension as { kind?: string } | null)?.kind === 'permanent')
        throw new Error('Conta banida pelo WhatsApp: não é possível reconectar.');
      let current: string | null = null;
      try {
        current = await engine.getStatus(a.sessionName);
      } catch {
        await engine.createSession(a.sessionName);
      }
      if (current === 'WORKING') {
        await applyStatus(a, 'WORKING', undefined, new Date());
        return;
      }
      await patch(id, { status: 'processing', qrAttempt: 0, isAuthenticated: false, lastDisconnectReason: null });
      if (current === 'SCAN_QR_CODE' || current === 'STARTING' || current === 'FAILED')
        await tryEngine('parar sessão', a.sessionName, () => engine.stopSession(a.sessionName));
      await engine.startSession(a.sessionName);
    },

    async qr(id: string): Promise<{ png: Buffer } | { connected: true }> {
      let a = await must(id);
      // sem webhook (perdido/atrasado) o status local fica velho: a tela de QR confere no engine e sincroniza
      try {
        await applyStatus(a, await engine.getStatus(a.sessionName), undefined, new Date());
        a = await must(id);
      } catch (e) {
        log(`[accounts] ler status ${a.sessionName}`, e);
      }
      if (isConnected(a.status)) return { connected: true };
      if (a.status !== 'pendingQrCode') throw new Error('QR ainda não disponível, tente de novo em instantes.');
      // o ciclo de 5 QRs é contado por evento (connection.ts); o do client não pode esgotar antes
      // shortcut: só o client direto expõe `qrCycle`; um engine embrulhado não zera (o ciclo do client pode esgotar antes)
      (engine as { qrCycle?: { reset(s: string): void } }).qrCycle?.reset(a.sessionName);
      try {
        const { image } = await engine.getQr(a.sessionName);
        return { png: Buffer.from(image.replace(/^data:[^,]*,/, ''), 'base64') };
      } catch (e) {
        log(`[accounts] obter QR ${a.sessionName}`, e);
        throw new Error('Não foi possível obter o QR agora, tente de novo em instantes.');
      }
    },

    async setRole(id: string, role: 'normal' | 'spy'): Promise<void> {
      const a = await must(id);
      // 'normal' = papel padrão (cria e envia)
      const next: AccountRole = role === 'spy' ? 'spy' : 'both';
      const rolePolicy = normalizeRolePolicy({ ...a.rolePolicy, role: next });
      await db.update(waAccounts).set({ rolePolicy, updatedAt: new Date() }).where(eq(waAccounts.id, id));
    },

    async remove(id: string): Promise<void> {
      const a = await must(id);
      // as duas chamadas rodam sempre; "sessão inexistente" é o resultado esperado de quem nunca conectou (ou já foi apagada)
      const failed = [
        await tryEngine('desconectar sessão', a.sessionName, () => engine.logoutSession(a.sessionName)),
        await tryEngine('apagar sessão', a.sessionName, () => engine.deleteSession(a.sessionName)),
      ].filter((e) => e && !sessionGone(e));
      if (failed.length)
        throw new Error(
          'Não foi possível encerrar a sessão no WhatsApp: a sessão ainda pode estar ativa, por isso a conta não foi removida. Tente de novo em instantes.',
        );
      await db.delete(waAccounts).where(eq(waAccounts.id, id));
    },

    async onSessionStatus(
      e: Extract<WaEvent, { kind: 'session.status' }>,
    ): Promise<{ handled: boolean; kind: 'session.status'; note?: string }> {
      const [a] = await db.select().from(waAccounts).where(eq(waAccounts.sessionName, e.session));
      if (!a) return { handled: false, kind: 'session.status', note: 'sessão desconhecida' };
      const t = await applyStatus(a, e.status, e.reason, new Date(e.ts));
      return { handled: true, kind: 'session.status', ...(t.changed ? {} : { note: 'sem mudança' }) };
    },
  };
}
