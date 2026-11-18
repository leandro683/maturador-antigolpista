import { describe, expect, it } from 'vitest';
import { brPhoneVariants, brVariants, isGroupJid, isLid, jidFromPhone, parseJid, phoneFromJid, toE164 } from '../src/phone';

describe('toE164', () => {
  it.each([
    ['+55 (11) 3333-0001', '+551133330001'], // fixo: 8 dígitos começando em 2–5 não ganha o 9º
    ['11 99999-0003', '+5511999990003'],
    ['1199990003', '+5511999990003'], // celular sem 9º dígito
    ['5511999990003', '+5511999990003'],
    ['011 99999-0003', '+5511999990003'],
    ['551199990003', '+5511999990003'],
    ['+1 415 555 2671', '+14155552671'],
  ])('%s → %s', (inp, out) => expect(toE164(inp)).toBe(out));

  it.each(['', 'abc', '123', '(20) 99999-8888', '45 89999-8888'])('inválido: %s', (inp) =>
    expect(toE164(inp)).toBeNull(),
  );

  it('forceBr=false não assume BR sem DDI', () => {
    expect(toE164('11999990003', { forceBr: false })).toBeNull();
  });
});

describe('variantes e JID', () => {
  it('brVariants ): qualquer formato → [com 9, sem 9] p/ celular BR', () => {
    const both = ['+5511999990002', '+551199990002'];
    expect(brVariants('5511999990002')).toEqual(both);
    expect(brVariants('551199990002@c.us')).toEqual(both);
    expect(brVariants('5511999990002@s.whatsapp.net')).toEqual(both);
    expect(brVariants('+55 (11) 99999-0002')).toEqual(both);
    expect(brVariants('11999990002')).toEqual(both);
    expect(brVariants('+551133330001')).toEqual(['+551133330001']);
    expect(brVariants('+14155552671')).toEqual(['+14155552671']);
    expect(brVariants('100000000000001@lid')).toEqual([]);
    expect(brVariants('lixo')).toEqual([]);
  });

  it('brPhoneVariants', () => {
    expect(brPhoneVariants('+5511999990003')).toEqual(['+5511999990003', '+551199990003']);
    expect(brPhoneVariants('+551133330001')).toEqual(['+551133330001']);
    expect(brPhoneVariants('+14155552671')).toEqual(['+14155552671']);
  });
  it('parseJid', () => {
    expect(parseJid('5511999990004@s.whatsapp.net')).toEqual({
      kind: 'user',
      user: '5511999990004',
      server: 's.whatsapp.net',
    });
    const device = 12; // JID de dispositivo: `usuário:dispositivo@servidor`
    expect(parseJid(`5511999990004:${device}@s.whatsapp.net`)).toEqual({
      kind: 'user',
      user: '5511999990004',
      server: 's.whatsapp.net',
      device,
    });
    expect(parseJid('100000000000002@lid').kind).toBe('lid');
    expect(isLid('100000000000002@lid')).toBe(true);
    expect(isGroupJid('1203630000000001@g.us')).toBe(true);
    expect(parseJid('nope').kind).toBe('unknown');
  });
  it('jidFromPhone / phoneFromJid', () => {
    expect(jidFromPhone('+5511999990003')).toBe('5511999990003@c.us');
    expect(phoneFromJid('5511999990003@c.us')).toBe('+5511999990003');
    expect(phoneFromJid('100000000000002@lid')).toBeNull();
  });
});

