import { describe, expect, it } from 'vitest';
import { APPROVED_MODELS, FREE_DEFAULT, PAID_DEFAULT, isFree, modelInfo } from '../src/models';

describe('lista aprovada de modelos', () => {
  it('tem 9 modelos e os padrões na ordem da lista', () => {
    expect(APPROVED_MODELS).toHaveLength(9);
    expect(FREE_DEFAULT).toHaveLength(6);
    expect(FREE_DEFAULT[0]).toBe('nvidia/nemotron-3-ultra-550b-a55b:free');
    expect(PAID_DEFAULT).toEqual(['mistralai/mistral-nemo', 'mistralai/mistral-small-24b-instruct-2501', 'z-ai/glm-5.3-flash']);
  });
  it('gratuitos terminam em :free e glm usa effort low', () => {
    expect(FREE_DEFAULT.every((s) => s.endsWith(':free') && isFree(s))).toBe(true);
    expect(PAID_DEFAULT.some(isFree)).toBe(false);
    for (const m of APPROVED_MODELS) expect(m.effort).toBe(m.slug === 'z-ai/glm-5.3-flash' ? 'low' : 'none');
    expect(modelInfo('x/y')).toBeUndefined();
    expect(isFree('x/y')).toBe(false);
  });
});
