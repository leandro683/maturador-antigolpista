import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { waAccounts } from '@mag/db/schema';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import { WahaHttpError, type WaEngine } from '@mag/wa-engine';
import { FakeEngine } from '@mag/wa-engine/fake';
import { createAccountsService } from '../src/service';

describe.skipIf(!PG_URL)('createAccountsService — Postgres real + FakeEngine', () => {
  let t: Awaited<ReturnType<typeof freshDb>>;
  let engine: FakeEngine;
  let svc: ReturnType<typeof createAccountsService>;

  beforeAll(async () => {
    t = await freshDb();
    engine = new FakeEngine();
    svc = createAccountsService(t.db, engine);
    // como o worker: evento do engine → service
    engine.onEvent(async (e) => {
      if (e.kind === 'session.status') await svc.onSessionStatus(e);
    });
  });
  afterAll(async () => {
    await t.drop();
  });

  const row = async (id: string) => (await t.db.select().from(waAccounts).where(eq(waAccounts.id, id)))[0]!;

  it('create: nome obrigatório, session_name = mag_<8 hex>, aparece em list', async () => {
    await expect(svc.create({ name: '  ' })).rejects.toThrow();
    const a = await svc.create({ name: ' Chip 1 ' });
    expect(a.name).toBe('Chip 1');
    expect(a.sessionName).toMatch(/^mag_[0-9a-f]{8}$/);
    expect(a.status).toBe('noStatus');
    expect(a.rolePolicy).toEqual({ role: 'both' });
    expect((await svc.list()).map((x) => x.id)).toContain(a.id);
  });

  it('connect → QR → pareou: status, jid, lid e last_connected_at gravados', async () => {
    const a = await svc.create({ name: 'Chip QR' });
    await svc.connect(a.id);
    expect(engine.sessions.has(a.sessionName)).toBe(true);
    expect((await row(a.id)).status).toBe('pendingQrCode');
    expect((await row(a.id)).qrAttempt).toBe(1);

    const q = await svc.qr(a.id);
    expect('png' in q && q.png.length > 0).toBe(true);

    await engine.pair(a.sessionName);
    const r = await row(a.id);
    expect(r.status).toBe('connected');
    expect(r.isAuthenticated).toBe(true);
    expect(r.jid).toBe(engine.sessions.get(a.sessionName)!.me.jid);
    expect(r.lastConnectedAt).toBeInstanceOf(Date);
    expect(await svc.qr(a.id)).toEqual({ connected: true });
  });

  it('onSessionStatus: queda grava last_disconnect_reason; sessão desconhecida não é tratada', async () => {
    const a = await svc.create({ name: 'Chip queda' });
    await svc.connect(a.id);
    await engine.pair(a.sessionName);
    const res = await svc.onSessionStatus({
      kind: 'session.status',
      session: a.sessionName,
      status: 'FAILED',
      reason: 'logged out',
      ts: Date.now(),
    });
    expect(res).toMatchObject({ handled: true, kind: 'session.status' });
    const r = await row(a.id);
    expect(r.status).toBe('needs_reauth');
    expect(r.lastDisconnectReason).toBe('logged out');

    const unknown = await svc.onSessionStatus({ kind: 'session.status', session: 'mag_ffffffff', status: 'WORKING', ts: 1 });
    expect(unknown.handled).toBe(false);
  });

  it('setRole grava role_policy.role e preserva os demais limites', async () => {
    const a = await svc.create({ name: 'Chip espia' });
    await t.db.update(waAccounts).set({ rolePolicy: { role: 'both', maxGroupSendsPerHour: 50 } }).where(eq(waAccounts.id, a.id));
    await svc.setRole(a.id, 'spy');
    expect((await row(a.id)).rolePolicy).toEqual({ role: 'spy', maxGroupSendsPerHour: 50 });
    await svc.setRole(a.id, 'normal');
    expect((await row(a.id)).rolePolicy).toMatchObject({ role: 'both' });
  });

  it('remove: apaga a sessão no engine e a linha; conta inexistente falha', async () => {
    const a = await svc.create({ name: 'Chip remover' });
    await svc.connect(a.id);
    await svc.remove(a.id);
    expect(engine.sessions.has(a.sessionName)).toBe(false);
    expect(await t.db.select().from(waAccounts).where(eq(waAccounts.id, a.id))).toHaveLength(0);
    await expect(svc.remove(a.id)).rejects.toThrow('conta não encontrada');
    await expect(svc.connect(a.id)).rejects.toThrow('conta não encontrada');
  });

  it('remove com sessão inexistente no engine (conta nunca conectada) não falha', async () => {
    const a = await svc.create({ name: 'Chip sem sessão' });
    await expect(svc.remove(a.id)).resolves.toBeUndefined();
  });

  // engine próprio (sem o ouvinte acima) e `log` espiado: os eventos entram por `onSessionStatus` na mão
  describe('falhas do engine', () => {
    let eng: FakeEngine;
    let s2: ReturnType<typeof createAccountsService>;
    const log = vi.fn();
    const JID = '5511999990001@c.us';
    const LID = '100000000000001@lid';

    beforeEach(() => {
      eng = new FakeEngine();
      log.mockReset();
      s2 = createAccountsService(t.db, eng, { log });
    });
    afterEach(() => vi.restoreAllMocks());

    const working = (session: string) => ({ kind: 'session.status' as const, session, status: 'WORKING' as const, ts: Date.now() });
    const mk = async (name: string, stored: { jid?: string | null; lid?: string | null } = {}) => {
      const a = await s2.create({ name });
      await s2.connect(a.id);
      if (Object.keys(stored).length) await t.db.update(waAccounts).set(stored).where(eq(waAccounts.id, a.id));
      return a;
    };

    it('sincronizar o perfil não apaga jid nem lid guardados quando o engine devolve vazio', async () => {
      const a = await mk('Chip perfil vazio', { jid: JID, lid: LID });
      vi.spyOn(eng, 'getMe').mockResolvedValue({ jid: '', pushName: '' });
      await s2.onSessionStatus(working(a.sessionName));
      expect(await row(a.id)).toMatchObject({ status: 'connected', jid: JID, lid: LID });
    });

    it('perfil com jid novo e sem lid troca o jid e mantém o lid', async () => {
      const a = await mk('Chip perfil parcial', { jid: JID, lid: LID });
      vi.spyOn(eng, 'getMe').mockResolvedValue({ jid: '5511999990002@c.us', pushName: '' });
      await s2.onSessionStatus(working(a.sessionName));
      expect(await row(a.id)).toMatchObject({ jid: '5511999990002@c.us', lid: LID });
    });

    it('perfil que falhou é tentado de novo no próximo evento (mesmo sem mudança de status) e a falha é registrada', async () => {
      const a = await mk('Chip perfil retry');
      const err = new Error('WAHA 503');
      vi.spyOn(eng, 'getMe').mockRejectedValueOnce(err);
      await s2.onSessionStatus(working(a.sessionName));
      expect(await row(a.id)).toMatchObject({ status: 'connected', jid: null });
      expect(log).toHaveBeenCalledWith(expect.stringContaining(a.sessionName), err);

      vi.spyOn(eng as WaEngine, 'getMe').mockResolvedValue({ jid: JID, lid: LID, pushName: '' });
      const again = await s2.onSessionStatus(working(a.sessionName));
      expect(again.note).toBe('sem mudança');
      expect(await row(a.id)).toMatchObject({ jid: JID, lid: LID });
    });

    it('connect numa conta já conectada e sem número tenta o perfil de novo', async () => {
      const a = await mk('Chip perfil connect');
      vi.spyOn(eng, 'getMe').mockRejectedValueOnce(new Error('WAHA 503'));
      await eng.pair(a.sessionName);
      await s2.onSessionStatus(working(a.sessionName));
      expect((await row(a.id)).jid).toBeNull();
      await s2.connect(a.id);
      expect((await row(a.id)).jid).toBe(eng.sessions.get(a.sessionName)!.me.jid);
    });

    it('connect: conta banida de vez pelo WhatsApp não reconecta', async () => {
      const a = await s2.create({ name: 'Chip banido' });
      const suspension = { suspended: true, kind: 'permanent', reason: 'ban', endsAt: null, detectedAt: new Date().toISOString() };
      await t.db.update(waAccounts).set({ status: 'inactive', whatsappSuspension: suspension }).where(eq(waAccounts.id, a.id));
      await expect(s2.connect(a.id)).rejects.toThrow('Conta banida pelo WhatsApp');
      expect(eng.sessions.has(a.sessionName)).toBe(false);
    });

    it('qr(): engine diz que a sessão já está conectada → sincroniza o status e devolve { connected: true }', async () => {
      const a = await mk('Chip webhook perdido');
      await s2.onSessionStatus({ kind: 'session.status', session: a.sessionName, status: 'SCAN_QR_CODE', ts: Date.now() });
      expect((await row(a.id)).status).toBe('pendingQrCode');
      eng.sessions.get(a.sessionName)!.status = 'WORKING'; // o pareamento aconteceu e o webhook se perdeu
      const getQr = vi.spyOn(eng, 'getQr');
      expect(await s2.qr(a.id)).toEqual({ connected: true });
      expect(getQr).not.toHaveBeenCalled();
      expect(await row(a.id)).toMatchObject({ status: 'connected', isAuthenticated: true });
    });

    it('qr(): QR ainda não gerado → mensagem em português, sem chamar o engine pedindo QR', async () => {
      const a = await s2.create({ name: 'Chip aguardando' });
      await s2.connect(a.id);
      await t.db.update(waAccounts).set({ status: 'processing' }).where(eq(waAccounts.id, a.id));
      eng.sessions.get(a.sessionName)!.status = 'STARTING';
      const getQr = vi.spyOn(eng, 'getQr');
      await expect(s2.qr(a.id)).rejects.toThrow('QR ainda não disponível');
      expect(getQr).not.toHaveBeenCalled();
    });

    it('qr(): erro do engine vira mensagem em português, sem vazar o texto cru', async () => {
      const a = await mk('Chip qr erro');
      const raw = new Error('WAHA 500 em /api/x/auth/qr: stack interno');
      vi.spyOn(eng, 'getQr').mockRejectedValue(raw);
      const p = s2.qr(a.id);
      await expect(p).rejects.toThrow(/não foi possível obter o QR/i);
      await expect(p).rejects.not.toThrow(/WAHA|stack interno/);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(a.sessionName), raw);
    });

    it('falha do engine num efeito do status (reiniciar sessão) é registrada, não engolida', async () => {
      const a = await mk('Chip restart');
      const err = new Error('WAHA 502');
      vi.spyOn(eng, 'startSession').mockRejectedValue(err);
      // QR expirou sem leitura: a máquina pede stop + start
      await s2.onSessionStatus({ kind: 'session.status', session: a.sessionName, status: 'FAILED', ts: Date.now() });
      expect(log).toHaveBeenCalledWith(expect.stringContaining(a.sessionName), err);
    });

    it('remove: falha do engine que não é "sessão inexistente" mantém a conta e avisa que a sessão pode estar ativa', async () => {
      const a = await mk('Chip remove falha');
      const err = new Error('WAHA 500');
      const del = vi.spyOn(eng, 'deleteSession').mockRejectedValue(err);
      await expect(s2.remove(a.id)).rejects.toThrow(/sessão.*ativa/);
      expect(await t.db.select().from(waAccounts).where(eq(waAccounts.id, a.id))).toHaveLength(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(a.sessionName), err);
      // engine volta: a nova tentativa apaga tudo
      del.mockRestore();
      await expect(s2.remove(a.id)).resolves.toBeUndefined();
      expect(await t.db.select().from(waAccounts).where(eq(waAccounts.id, a.id))).toHaveLength(0);
      expect(eng.sessions.has(a.sessionName)).toBe(false);
    });

    it('remove: falha só no logout também mantém a conta e ainda tenta apagar a sessão; a segunda tentativa conclui', async () => {
      const a = await mk('Chip logout falha');
      vi.spyOn(eng, 'logoutSession').mockRejectedValue(new Error('WAHA 500'));
      await expect(s2.remove(a.id)).rejects.toThrow(/sessão.*ativa/);
      expect(eng.sessions.has(a.sessionName)).toBe(false); // o delete foi tentado e passou
      expect(await t.db.select().from(waAccounts).where(eq(waAccounts.id, a.id))).toHaveLength(1);
      vi.restoreAllMocks();
      await expect(s2.remove(a.id)).resolves.toBeUndefined(); // sessão já não existe: segue
      expect(await t.db.select().from(waAccounts).where(eq(waAccounts.id, a.id))).toHaveLength(0);
    });

    it('remove: 404 do WAHA conta como "sessão inexistente"', async () => {
      const a = await mk('Chip remove 404');
      const gone = new WahaHttpError(404, '/api/sessions/x', 'not found');
      vi.spyOn(eng, 'logoutSession').mockRejectedValue(gone);
      vi.spyOn(eng, 'deleteSession').mockRejectedValue(gone);
      await expect(s2.remove(a.id)).resolves.toBeUndefined();
      expect(await t.db.select().from(waAccounts).where(eq(waAccounts.id, a.id))).toHaveLength(0);
    });
  });
});
