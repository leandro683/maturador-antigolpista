import { describe, expect, it } from 'vitest';
import { effectiveCaps, normalizeRolePolicy } from '../src/role-policy';
import { waAccountStatus } from '@mag/db/schema';
import { ACC_STATUSES, matchesFilter, parseFilter } from '../src/status';

describe('role_policy', () => {
  it('normaliza e aplica defaults por papel', () => {
    const p = normalizeRolePolicy({ role: 'creator', maxGroupCreatesPerDay: '10' });
    expect(p).toEqual({ role: 'creator', maxGroupCreatesPerDay: 10 });
    expect(effectiveCaps(p)).toMatchObject({
      canCreateGroups: true,
      canSend: false,
      maxGroupCreatesPerDay: 10,
      maxGroupSendsPerHour: 0,
    });
    expect(effectiveCaps({ role: 'spy' })).toMatchObject({ canCreateGroups: false, canSend: false });
    expect(effectiveCaps({ role: 'both' })).toMatchObject({
      maxGroupCreatesPerDay: 20,
      maxGroupSendsPerHour: 200,
    });
    expect(() => normalizeRolePolicy({ role: 'admin' })).toThrow();
  });
});

describe('enum de estados da conta', () => {
  it('ACC_STATUSES = enum mag.wa_account_status', () => {
    expect([...ACC_STATUSES]).toEqual(waAccountStatus.enumValues);
  });
});

describe('filtros', () => {
  it('abas', () => {
    expect(matchesFilter('connected', 'conectadas')).toBe(true);
    expect(matchesFilter('restricted', 'conectadas')).toBe(true);
    expect(matchesFilter('needs_reauth', 'desconectadas')).toBe(true);
    expect(matchesFilter('noStatus', 'desconectadas')).toBe(false);
    expect(matchesFilter('noStatus', 'sem-sessao')).toBe(true);
    expect(parseFilter('x')).toBe('todas');
  });
});
