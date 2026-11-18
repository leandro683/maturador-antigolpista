import { describe, expect, it, vi } from 'vitest';
import { chainSecHandlers } from '../src/processors/sec-events';

const ev = (kind: string) => ({ kind, session: 's', gid: '1203630000000001@g.us', ts: Date.now() }) as never;
const ctx = { raw: null, stale: false };

describe('chainSecHandlers', () => {
  it('erro no anti-golpista não derruba o dono: ele roda, o erro é logado e o aval não é dado', async () => {
    const log = vi.fn();
    const sec = vi.fn(async () => {
      throw new Error('banco caiu');
    });
    const owner = vi.fn(async () => ({ note: 'dono rodou' }));
    const h = chainSecHandlers({ 'group.participants': owner } as never, { 'group.participants': sec } as never, log);
    const r = await h['group.participants']!(ev('group.participants'), ctx);
    expect(owner).toHaveBeenCalledOnce();
    expect(owner).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ secAccepted: false }));
    expect(r).toMatchObject({ note: 'dono rodou' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('banco caiu'));
  });

  it('kind sem dono (message.reaction): o anti-golpista roda e o resultado não dá erro', async () => {
    const sec = vi.fn(async () => ({ handled: true, incidents: ['i1'], note: 'reação suspeita' }));
    const h = chainSecHandlers({} as never, { 'message.reaction': sec } as never);
    const r = await h['message.reaction']!(ev('message.reaction'), ctx);
    expect(sec).toHaveBeenCalledOnce();
    expect(r).toEqual({ sec: 'sec: reação suspeita' });
  });

  it('evento atrasado: pula o anti-golpista, mas chega ao dono (sem aval)', async () => {
    const sec = vi.fn(async () => ({ accepted: true }));
    const owner = vi.fn(async () => ({ note: 'dono' }));
    const h = chainSecHandlers({ 'group.update': owner } as never, { 'group.update': sec } as never);
    const r = await h['group.update']!(ev('group.update'), { raw: null, stale: true });
    expect(sec).not.toHaveBeenCalled();
    expect(owner).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stale: true, secAccepted: false }));
    expect(r).toMatchObject({ note: 'dono' });
  });

  it('o dono só recebe o aval quando o anti-golpista devolve accepted: true', async () => {
    for (const [result, expected] of [
      [{ handled: true, accepted: true }, true],
      [{ handled: true, note: 'alteração não autorizada', incidents: ['i1'] }, false],
      [undefined, false],
    ] as const) {
      const owner = vi.fn(async () => undefined);
      const h = chainSecHandlers({ 'group.update': owner } as never, { 'group.update': async () => result } as never);
      await h['group.update']!(ev('group.update'), ctx);
      expect(owner).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ secAccepted: expected }));
    }
  });
});
