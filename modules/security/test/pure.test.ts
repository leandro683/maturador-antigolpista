import { describe, expect, it } from 'vitest';
import { DEFAULT_ANTI_HACKER, readAntiHacker, readiness } from '../src/config';
import { auditGroupAdmins, changedFields, inviteCodeOf, isClosed, messageAuthor } from '../src/detect';
import { createPublicLimiter } from '../src/public-verify';
import { identityOf, IdentitySet, jidOf } from '../src/identity';

describe('config', () => {
  it('jsonb simples ({enabled, reactionProtection}) → defaults do anti-golpista', () => {
    expect(readAntiHacker({ enabled: true, reactionProtection: false })).toEqual({
      ...DEFAULT_ANTI_HACKER,
      enabled: true,
      reactionProtection: false,
    });
    expect(readAntiHacker(null).enabled).toBe(false);
  });

  it('campo inválido cai no default sem perder os válidos', () => {
    const c = readAntiHacker({ enabled: true, suspiciousPatterns: ['('], removeAuthor: 'sim' });
    expect(c.enabled).toBe(true);
    expect(c.removeAuthor).toBe(true);
    expect(c.suspiciousPatterns).toEqual(DEFAULT_ANTI_HACKER.suspiciousPatterns);
  });

  it('readiness exige conta espiã + números administrativos', () => {
    expect(readiness({ accounts: [{ rolePolicy: { role: 'both' }, status: 'active' }], adminNumbers: 0 })).toMatchObject({
      ok: false,
      missing: ['ative uma conta espiã nesta campanha', 'cadastre os números administrativos'],
    });
    expect(
      readiness({ accounts: [{ rolePolicy: { role: 'spy' }, status: 'disconnected' }], adminNumbers: 2 }),
    ).toMatchObject({ ok: true, spyActive: false, missing: ['a conta espiã não está conectada'] });
  });
});

describe('identidade', () => {
  it('casa telefone com/sem 9º dígito e LID', () => {
    const s = new IdentitySet([identityOf('+55 11 99999-0021'), identityOf('100000000000004@lid')]);
    expect(s.has(identityOf('551199990021@c.us'))).toBe(true);
    expect(s.has(identityOf('100000000000004@lid'))).toBe(true);
    expect(s.has(identityOf('5511999990022@c.us'))).toBe(false);
    expect(jidOf(identityOf('+5511999990021'))).toBe('5511999990021@c.us');
  });
});

describe('detecção', () => {
  it('grupo fechado: settings.announce vence o template', () => {
    expect(isClosed({ announce: false }, true)).toBe(false);
    expect(isClosed({}, true)).toBe(true);
  });

  it('auditGroupAdmins lista admins fora da allowlist (dry-run)', () => {
    const allow = new IdentitySet([identityOf('5511999990001')]);
    const r = auditGroupAdmins(
      {
        gid: 'g',
        subject: 's',
        participants: [
          { jid: '5511999990001@c.us', isAdmin: true, isSuperAdmin: true },
          { jid: '100000000000005@lid', isAdmin: true, isSuperAdmin: false },
          { jid: '5511999990008@c.us', isAdmin: false, isSuperAdmin: false },
        ],
      },
      allow,
    );
    expect(r.offenders.map((o) => o.label)).toEqual(['100000000000005@lid']);
  });

  it('auditGroupAdmins reconhece o admin da lista oficial só pelo LID (lid do grupo sem o sufixo)', () => {
    const allow = new IdentitySet([identityOf('100000000000001@lid')]);
    const r = auditGroupAdmins(
      { gid: 'g', subject: 's', participants: [{ jid: '5511999990008@c.us', lid: '100000000000001', isAdmin: true, isSuperAdmin: false }] },
      allow,
    );
    expect(r.offenders).toEqual([]);
  });

  it('inviteCodeOf tira o link; changedFields compara o código puro', () => {
    expect(inviteCodeOf('https://chat.whatsapp.com/ABC123?mode=ems')).toBe('ABC123');
    expect(inviteCodeOf(' ABC123 ')).toBe('ABC123');
    expect(inviteCodeOf('')).toBeNull();
    expect(inviteCodeOf(undefined)).toBeNull();
    const base = { name: 'x', description: null, inviteCode: 'ABC123' };
    expect(changedFields({ inviteCode: 'https://chat.whatsapp.com/ABC123' }, base)).toEqual({});
    expect(changedFields({ inviteCode: 'OUTRO' }, base)).toEqual({ inviteCode: 'OUTRO' });
  });

  it('changedFields trata a descrição gravada vazia como qualquer outro valor esperado', () => {
    const base = { name: 'x', description: null, inviteCode: null };
    expect(changedFields({ subject: 'x', description: 'y' }, base)).toEqual({ description: 'y' });
    expect(changedFields({ subject: 'x', description: '' }, base)).toEqual({});
  });
});

describe('limite da página pública', () => {
  it('10 consultas/min por IP e 120/min por página; janela desliza', () => {
    let t = 0;
    const allow = createPublicLimiter(() => t);
    for (let i = 0; i < 10; i++) expect(allow('10.0.0.1', 'pg1')).toBe(true);
    expect(allow('10.0.0.1', 'pg1')).toBe(false);
    expect(allow('10.0.0.2', 'pg1')).toBe(true); // outro IP segue
    for (let i = 0; i < 200; i++) allow(`9.9.${i}.1`, 'pg2');
    expect(allow('10.0.0.3', 'pg2')).toBe(false); // teto da página (enumeração por muitos IPs)
    t = 61_000;
    expect(allow('10.0.0.1', 'pg1')).toBe(true);
  });
});

describe('autor da mensagem pelo id serializado', () => {
  it('false_{chat}_{id}_{autor} → autor; true_ → nossa; id curto → desconhecido', () => {
    const chat = '1203630000000001@g.us';
    const autor = '5511999990023';
    const lid = '100000000000006@lid';
    expect(messageAuthor(`false_${chat}_3EB0AA_${autor}@c.us`)).toEqual({ fromMe: false, author: `${autor}@c.us` });
    expect(messageAuthor(`false_${chat}_3EB0AA_${lid}`)).toMatchObject({ author: lid });
    expect(messageAuthor(`true_${chat}_3EB0AA_${autor}@c.us`).fromMe).toBe(true);
    expect(messageAuthor('3EB0AA')).toEqual({ fromMe: false, author: null });
  });
});
