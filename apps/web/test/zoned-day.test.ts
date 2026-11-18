import { describe, expect, it } from 'vitest';
import { zonedDay } from '@/lib/zoned-day';

describe('zonedDay', () => {
  it('início do dia no fuso informado; end = início do dia seguinte', () => {
    expect(zonedDay('2026-03-10', false, 'America/Sao_Paulo')?.toISOString()).toBe('2026-03-10T03:00:00.000Z');
    expect(zonedDay('2026-03-10', true, 'America/Sao_Paulo')?.toISOString()).toBe('2026-03-11T03:00:00.000Z');
    expect(zonedDay('2026-03-10', false, 'America/Manaus')?.toISOString()).toBe('2026-03-10T04:00:00.000Z');
    expect(zonedDay('2026-03-10', false, 'UTC')?.toISOString()).toBe('2026-03-10T00:00:00.000Z');
    expect(zonedDay('2026-12-31', true, 'UTC')?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('respeita o horário de verão do fuso (Nova York muda em março)', () => {
    expect(zonedDay('2026-03-07', false, 'America/New_York')?.toISOString()).toBe('2026-03-07T05:00:00.000Z');
    expect(zonedDay('2026-03-09', false, 'America/New_York')?.toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });

  it('usa APP_TZ quando o fuso não é passado', () => {
    process.env.APP_TZ = 'America/Manaus';
    try {
      expect(zonedDay('2026-03-10')?.toISOString()).toBe('2026-03-10T04:00:00.000Z');
    } finally {
      delete process.env.APP_TZ;
    }
    expect(zonedDay('2026-03-10')?.toISOString()).toBe('2026-03-10T03:00:00.000Z');
  });

  it('data inexistente, formato errado ou fuso inválido → undefined', () => {
    expect(zonedDay('2026-02-31')).toBeUndefined();
    expect(zonedDay('10/03/2026')).toBeUndefined();
    expect(zonedDay('', true)).toBeUndefined();
    expect(zonedDay('2026-03-10', false, 'Marte/Olympus')).toBeUndefined();
  });
});
