import { describe, expect, it } from 'vitest';
import { chipBadge } from '../app/(painel)/maturador/chip-badge';

const chip = (over: object) => ({ active: true, pausedReason: null, status: 'connected', ...over });

describe('chipBadge', () => {
  it('conectada (status real do banco) aparece como Aquecendo', () => {
    expect(chipBadge(chip({}))).toEqual({ tone: 'ok', text: 'Aquecendo', dot: true });
    expect(chipBadge(chip({ status: 'active' })).text).toBe('Aquecendo');
  });
  it('restrita tem selo próprio com texto', () => expect(chipBadge(chip({ status: 'restricted' }))).toEqual({ tone: 'warn', text: 'Restrito' }));
  it('desconectada', () => expect(chipBadge(chip({ status: 'disconnected' }))).toMatchObject({ tone: 'bad', text: 'Conta desconectada' }));
  it('pausado mostra o motivo', () =>
    expect(chipBadge(chip({ active: false, pausedReason: 'restrito' }))).toEqual({ tone: 'warn', text: 'Pausado: restrito' }));
});
