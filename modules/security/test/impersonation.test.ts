import { describe, expect, it } from 'vitest';
import { DEFAULT_IMPERSONATION_NAMES, antiHackerSchema, readAntiHacker } from '../src/config';
import { judgeProfile } from '../src/detect';

const cfg = (over: Partial<Parameters<typeof judgeProfile>[0]['cfg']> = {}) => ({
  impersonationPhotos: [{ label: 'Arte Oficial', hash: '00ff00ff00ff00ff' }],
  impersonationNames: [...DEFAULT_IMPERSONATION_NAMES],
  ...over,
});

describe('judgeProfile', () => {
  it('foto igual tem precedência sobre o nome', () => {
    expect(judgeProfile({ name: 'Suporte', photoHash: '00ff00ff00ff00ff', cfg: cfg() })).toEqual({
      match: 'photo',
      matched: 'Arte Oficial',
      distance: 0,
    });
  });

  it('foto a poucos bits ainda casa; longe não casa', () => {
    expect(judgeProfile({ photoHash: '00ff00ff00ff00f0', cfg: cfg() })).toMatchObject({ match: 'photo', distance: 4 });
    expect(judgeProfile({ photoHash: 'ffffffffffffffff', cfg: cfg() }).match).toBeNull();
  });

  it('nome casa sem diferenciar maiúsculas, com a grafia correta e a errada', () => {
    expect(judgeProfile({ name: '~ ADIMINISTRAÇAO', cfg: cfg() })).toMatchObject({ match: 'name' });
    expect(judgeProfile({ name: 'ADMINISTRAÇÃO', cfg: cfg() })).toMatchObject({ match: 'name' });
    expect(judgeProfile({ name: 'Suporte Exemplo', cfg: cfg() })).toEqual({ match: 'name', matched: 'Suporte' });
  });

  it('respeita limites de palavra', () => {
    expect(judgeProfile({ name: 'Maria Suportes', cfg: cfg() }).match).toBeNull();
    expect(judgeProfile({ name: 'Adriana', cfg: cfg() }).match).toBeNull();
  });

  it('sem nome nem foto -> null', () => {
    expect(judgeProfile({ cfg: cfg() }).match).toBeNull();
    expect(judgeProfile({ name: null, photoHash: null, cfg: cfg() }).match).toBeNull();
  });

  it('nome de 5.000 caracteres não trava (truncado em 100)', () => {
    const t = Date.now();
    const v = judgeProfile({ name: 'a'.repeat(5000) + ' suporte', cfg: cfg() });
    expect(Date.now() - t).toBeLessThan(1000);
    expect(v.match).toBeNull(); // o suporte esta depois dos 100 caracteres
  });
});

describe('config de impostor', () => {
  it('padrões: impersonation off, sem fotos, nomes default', () => {
    const c = readAntiHacker({});
    expect(c.impersonation).toBe('off');
    expect(c.impersonationPhotos).toEqual([]);
    expect(c.impersonationNames).toEqual([...DEFAULT_IMPERSONATION_NAMES]);
    expect(c.impersonationRemoveByName).toBe(false);
    expect(c.impersonationAutoScan).toBe(false);
  });

  it('regex inválida em impersonationNames cai no padrão, sem derrubar o resto', () => {
    const c = readAntiHacker({ impersonation: 'auto', impersonationNames: ['('] });
    expect(c.impersonation).toBe('auto');
    expect(c.impersonationNames).toEqual([...DEFAULT_IMPERSONATION_NAMES]);
  });

  it('hash de foto precisa ter 16 hex', () => {
    expect(antiHackerSchema.safeParse({ impersonationPhotos: [{ label: 'x', hash: 'zz' }] }).success).toBe(false);
  });
});
