import { describe, expect, it } from 'vitest';
import { rampFor } from '../src/ramp';

describe('rampFor', () => {
  it('falas: 60 no dia 1, 80 no dia 2, 100 do dia 3 em diante; parceiros na subida lenta', () => {
    expect(rampFor(1)).toEqual({ goal: 60, partners: 2 });
    expect(rampFor(2)).toEqual({ goal: 80, partners: 2 });
    expect(rampFor(3)).toEqual({ goal: 100, partners: 3 });
    expect(rampFor(5)).toEqual({ goal: 100, partners: 3 });
    expect(rampFor(6)).toEqual({ goal: 100, partners: 5 });
    expect(rampFor(10)).toEqual({ goal: 100, partners: 5 });
    expect(rampFor(11)).toEqual({ goal: 100, partners: Infinity });
  });
});
