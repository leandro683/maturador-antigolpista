import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@mag/db';

const scan = vi.hoisted(() => ({ startScan: vi.fn(), activeScan: vi.fn() }));
vi.mock('../src/scan', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...scan }));

import { AUTO_SCAN_WINDOW_MS, runAutoScan } from '../src/auto-scan';
import { ScanAlreadyRunningError } from '../src/scan';

/** Vigia automática: quem entra na rodada, sempre com janela de 48 h, nada duplicado, erro isolado. */
const ON = { enabled: true, impersonation: 'auto', impersonationAutoScan: true };
const db = (rows: { id: string; antiHacker: unknown }[]) =>
  ({ select: () => ({ from: () => ({ where: async () => rows }) }) }) as unknown as Db;
const create = vi.fn();
// São Paulo é UTC-3 o ano todo
const at = (iso: string) => () => new Date(iso);

describe('runAutoScan', () => {
  beforeEach(() => {
    scan.startScan.mockReset().mockResolvedValue('act');
    scan.activeScan.mockReset().mockResolvedValue(null);
  });

  it('só inicia campanha com as 3 condições', async () => {
    const rows = [
      { id: 'ok', antiHacker: ON },
      { id: 'desligada', antiHacker: { ...ON, enabled: false } },
      { id: 'revisao', antiHacker: { ...ON, impersonation: 'review' } },
      { id: 'sem-caixa', antiHacker: { ...ON, impersonationAutoScan: false } },
      { id: 'sem-config', antiHacker: null },
      // modo simulação promete não remover ninguém: a vigia automática não roda
      { id: 'simulacao', antiHacker: { ...ON, dryRun: true } },
    ];
    const r = await runAutoScan({ db: db(rows), create, now: at('2026-11-17T17:07:00Z') });
    expect(r).toEqual({ started: ['ok'], skipped: [], failed: [] });
    expect(scan.startScan).toHaveBeenCalledTimes(1);
    expect(scan.startScan.mock.calls[0]![2]).toBe('ok');
  });

  it('sempre com janela de 48 h, inclusive às 03:07 (sem rodada completa)', async () => {
    await runAutoScan({ db: db([{ id: 'a', antiHacker: ON }]), create, now: at('2026-11-17T17:07:00Z') });
    expect(scan.startScan.mock.calls[0]![3]).toEqual({
      messageLimit: 0,
      checkProfiles: true,
      autoAct: true,
      since: new Date(Date.parse('2026-11-17T17:07:00Z') - AUTO_SCAN_WINDOW_MS).toISOString(),
    });
    await runAutoScan({ db: db([{ id: 'a', antiHacker: ON }]), create, now: at('2026-11-17T06:07:00Z') });
    expect(scan.startScan.mock.calls[1]![3]).toEqual({
      messageLimit: 0,
      checkProfiles: true,
      autoAct: true,
      since: new Date(Date.parse('2026-11-17T06:07:00Z') - AUTO_SCAN_WINDOW_MS).toISOString(),
    });
  });

  it('análise em andamento: pula sem criar; corrida na trava também pula', async () => {
    scan.activeScan.mockImplementation(async (_db: unknown, id: string) => (id === 'a' ? 'x' : null));
    scan.startScan.mockImplementation(async (_d: unknown, _c: unknown, id: string) => {
      if (id === 'b') throw new ScanAlreadyRunningError('y');
      return 'act';
    });
    const rows = ['a', 'b', 'c'].map((id) => ({ id, antiHacker: ON }));
    const r = await runAutoScan({ db: db(rows), create, now: at('2026-11-17T17:07:00Z') });
    expect(r).toEqual({ started: ['c'], skipped: ['a', 'b'], failed: [] });
    expect(scan.startScan.mock.calls.map((c) => c[2])).toEqual(['b', 'c']);
  });

  it('erro numa campanha não impede a seguinte e vai para o log', async () => {
    scan.startScan.mockImplementation(async (_d: unknown, _c: unknown, id: string) => {
      if (id === 'a') throw new Error('fila fora');
      return 'act';
    });
    const log = vi.fn();
    const rows = ['a', 'b'].map((id) => ({ id, antiHacker: ON }));
    const r = await runAutoScan({ db: db(rows), create, now: at('2026-11-17T17:07:00Z'), log });
    expect(r).toEqual({ started: ['b'], skipped: [], failed: ['a'] });
    expect(log).toHaveBeenCalledWith('[sec] análise automática: a falhou: fila fora');
    expect(log).toHaveBeenLastCalledWith('[sec] análise automática: 1 iniciada(s), 0 pulada(s), 1 com erro');
  });
});
