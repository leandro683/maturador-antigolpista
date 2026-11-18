import { describe, expect, it } from 'vitest';
import { classifyFailure, onEngineStatus, type ConnSnapshot } from '../src/connection';
import { QR_CYCLE_MAX, refreshIntervalMs } from '../src/status';

const now = new Date('2026-10-16T12:00:00Z');
const base: ConnSnapshot = {
  status: 'processing',
  qrAttempt: 0,
  isAuthenticated: false,
  reachoutTimelock: null,
  whatsappSuspension: null,
};
const ev = (t: ReturnType<typeof onEngineStatus>) =>
  t.effects.map((e) => (e.type === 'outbox' ? `outbox:${e.event}` : e.type));

describe('máquina de estados de conexão', () => {
  it('SCAN_QR_CODE abre tentativa 1 → pendingQrCode + outbox qrcode.generated', () => {
    const t = onEngineStatus(base, 'SCAN_QR_CODE', undefined, now);
    expect(t.patch).toMatchObject({ status: 'pendingQrCode', qrAttempt: 1 });
    expect(ev(t)).toEqual(['outbox:account.qrcode.generated']);
    const out = t.effects[0];
    expect(out?.type === 'outbox' && out.data).toMatchObject({ attempt: 1, maxAttempts: QR_CYCLE_MAX });
  });

  it('SCAN_QR_CODE repetido (ruído do WAHA) não consome tentativa', () => {
    const s = { ...base, status: 'pendingQrCode' as const, qrAttempt: 2 };
    const t = onEngineStatus(s, 'SCAN_QR_CODE', undefined, now);
    expect(t.changed).toBe(false);
    expect(t.effects).toEqual([]);
  });

  it('QR expira (FAILED sem autenticar) antes da 5ª → restart', () => {
    const s = { ...base, status: 'pendingQrCode' as const, qrAttempt: 3 };
    const t = onEngineStatus(s, 'FAILED', undefined, now);
    expect(t.patch).toMatchObject({ status: 'processing' });
    expect(ev(t)).toEqual(['restart']);
  });

  it('5ª expiração → stop + needs_reauth + outbox qrcode.expired + alerta', () => {
    const s = { ...base, status: 'pendingQrCode' as const, qrAttempt: QR_CYCLE_MAX };
    const t = onEngineStatus(s, 'FAILED', undefined, now);
    expect(t.patch).toMatchObject({ status: 'needs_reauth', lastDisconnectReason: 'qr_expired' });
    expect(ev(t)).toEqual(['stop', 'outbox:account.qrcode.expired', 'alert']);
  });

  it('ciclo completo de 5 QRs com restarts', () => {
    let s: ConnSnapshot = { ...base };
    const restarts: number[] = [];
    for (let i = 1; i <= QR_CYCLE_MAX; i++) {
      const a = onEngineStatus(s, 'STARTING', undefined, now);
      s = { ...s, ...a.patch };
      const q = onEngineStatus(s, 'SCAN_QR_CODE', undefined, now);
      s = { ...s, ...q.patch };
      expect(s.qrAttempt).toBe(i);
      const f = onEngineStatus(s, 'FAILED', undefined, now);
      s = { ...s, ...f.patch };
      if (f.effects.some((e) => e.type === 'restart')) restarts.push(i);
    }
    expect(restarts).toEqual([1, 2, 3, 4]);
    expect(s.status).toBe('needs_reauth');
  });

  it('WORKING pareia: connected, zera tentativas, outbox paired + sync de perfil', () => {
    const s = { ...base, status: 'pendingQrCode' as const, qrAttempt: 2 };
    const t = onEngineStatus(s, 'WORKING', undefined, now);
    expect(t.patch).toMatchObject({
      status: 'connected',
      qrAttempt: 0,
      isAuthenticated: true,
      lastConnectedAt: now,
    });
    expect(ev(t)).toEqual(['outbox:account.paired', 'sync_profile']);
  });

  it('WORKING de conta já autenticada (reconexão) não repete paired', () => {
    const s = { ...base, status: 'reconnecting' as const, isAuthenticated: true };
    const t = onEngineStatus(s, 'WORKING', undefined, now);
    expect(t.patch.status).toBe('connected');
    expect(ev(t)).toEqual(['sync_profile']);
  });

  it('WORKING com timelock ativo mantém restricted', () => {
    const s = {
      ...base,
      status: 'reconnecting' as const,
      isAuthenticated: true,
      reachoutTimelock: { isActive: true },
    };
    expect(onEngineStatus(s, 'WORKING', undefined, now).patch.status).toBe('restricted');
  });

  it('STARTING: processing p/ nova; reconnecting p/ autenticada', () => {
    expect(onEngineStatus({ ...base, status: 'noStatus' }, 'STARTING', undefined, now).patch.status).toBe(
      'processing',
    );
    expect(onEngineStatus(base, 'STARTING', undefined, now).changed).toBe(false);
    const s = { ...base, status: 'connected' as const, isAuthenticated: true };
    expect(onEngineStatus(s, 'STARTING', undefined, now).patch.status).toBe('reconnecting');
  });

  it('aparelho removido (FAILED após autenticada) → needs_reauth + logged-out', () => {
    const s = { ...base, status: 'connected' as const, isAuthenticated: true };
    const t = onEngineStatus(s, 'FAILED', 'stream error: device removed', now);
    expect(t.patch).toMatchObject({ status: 'needs_reauth', isAuthenticated: false });
    expect(ev(t)).toEqual(['outbox:account.logged-out', 'alert']);
  });

  it('ban permanente → inactive + whatsapp_suspension + outbox banned', () => {
    const s = { ...base, status: 'connected' as const, isAuthenticated: true };
    const t = onEngineStatus(s, 'FAILED', 'account banned (403)', now);
    expect(t.patch.status).toBe('inactive');
    expect(t.patch.whatsappSuspension).toMatchObject({ suspended: true, kind: 'permanent' });
    expect(ev(t)).toEqual(['stop', 'outbox:account.banned', 'alert']);
  });

  it('ban temporário → restricted + suspension temp + outbox restricted', () => {
    const s = { ...base, status: 'connected' as const, isAuthenticated: true };
    const t = onEngineStatus(s, 'FAILED', 'temp banned 402', now);
    expect(t.patch.status).toBe('restricted');
    expect(t.patch.whatsappSuspension).toMatchObject({ suspended: true, kind: 'temporary' });
    expect(ev(t)).toEqual(['stop', 'outbox:account.restricted', 'alert']);
  });

  it('STOPPED preserva disconnected/needs_reauth/inactive; senão → disconnected', () => {
    for (const st of ['disconnected', 'needs_reauth', 'inactive', 'processing', 'noStatus'] as const)
      expect(onEngineStatus({ ...base, status: st }, 'STOPPED', undefined, now).changed).toBe(false);
    expect(onEngineStatus({ ...base, status: 'connected' }, 'STOPPED', undefined, now).patch.status).toBe(
      'disconnected',
    );
  });

  it('status desconhecido do engine é ignorado', () => {
    expect(onEngineStatus(base, 'WHATEVER', undefined, now).changed).toBe(false);
  });
});

describe('classifyFailure', () => {
  it.each([
    ['temp banned', 'temp_banned'],
    ['ConnectFailure 402', 'temp_banned'],
    ['banned', 'banned'],
    ['403 forbidden', 'banned'],
    ['device removed', 'logged_out'],
    ['Logged out', 'logged_out'],
    ['401', 'logged_out'],
    [undefined, 'unknown'],
    ['timeout', 'unknown'],
  ])('%s → %s', (r, k) => expect(classifyFailure(r)).toBe(k));
});

describe('refresh leve das telas de contas', () => {
  it('sem sessão/pareando → 5 s; conectada/banida → 30 s', () => {
    for (const s of [
      'noStatus',
      'imported',
      'pendingQrCode',
      'processing',
      'reconnecting',
      'disconnected',
    ] as const)
      expect(refreshIntervalMs(s)).toBe(5_000);
    for (const s of ['connected', 'active', 'restricted', 'inactive'] as const)
      expect(refreshIntervalMs(s)).toBe(30_000);
  });
});
