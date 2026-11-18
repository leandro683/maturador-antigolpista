import { describe, expect, it, vi } from 'vitest';
import { mapWahaEvent, type WaEvent, type WahaWebhook } from '@mag/wa-engine';
import { STALE_EVENT_MS, createWaEventsProcessor, handleWaEvent, isStaleEvent } from '../src/processors/wa-events';
import { chainSecHandlers } from '../src/processors/sec-events';

const MIN = 60_000;
const GID = '1203630000000001@g.us';
const participants = (ts: number): WaEvent => ({
  kind: 'group.participants',
  session: 's',
  gid: GID,
  action: 'add',
  participants: [{ jid: '5511999990001@c.us' }],
  ts,
});
const joinWebhook = () =>
  ({
    event: 'group.v2.participants',
    session: 's',
    payload: { group: { id: GID }, type: 'join', participants: [{ id: '100000000000001@lid' }] },
  }) as unknown as WahaWebhook;

describe('evento atrasado', () => {
  it('isStaleEvent: > 10 min é atrasado; exatamente 10 min ou menos não', () => {
    const now = Date.now();
    expect(STALE_EVENT_MS).toBe(600_000);
    expect(isStaleEvent(now - 600_001, now)).toBe(true);
    expect(isStaleEvent(now - 600_000, now)).toBe(false);
    expect(isStaleEvent(now - 60_000, now)).toBe(false);
  });

  it('handleWaEvent passa ctx.stale ao handler (11 min → true; 1 min → false)', async () => {
    const seen: boolean[] = [];
    const deps = {
      handlers: { 'group.participants': async (_e: unknown, ctx: { stale: boolean }) => void seen.push(ctx.stale) },
    };
    await handleWaEvent(participants(Date.now() - 11 * MIN), deps as never);
    await handleWaEvent(participants(Date.now() - 1 * MIN), deps as never);
    expect(seen).toEqual([true, false]);
  });

  it('kind sem handler: não tratado, com nota', async () => {
    const r = await handleWaEvent(participants(Date.now()), { handlers: {} });
    expect(r).toMatchObject({ handled: false, kind: 'group.participants', note: 'sem handler' });
  });

  it('session.status atrasado não chama o serviço de contas; em dia chama', async () => {
    const accountStatus = vi.fn(async () => ({ handled: true, kind: 'session.status' as const }));
    const e = (ts: number) => ({ kind: 'session.status', session: 's', status: 'FAILED', ts }) as WaEvent;
    const r = await handleWaEvent(e(Date.now() - 11 * MIN), { handlers: {}, accountStatus });
    expect(accountStatus).not.toHaveBeenCalled();
    expect(r).toMatchObject({ handled: true, note: 'atrasado: ignorado' });
    await handleWaEvent(e(Date.now()), { handlers: {}, accountStatus });
    expect(accountStatus).toHaveBeenCalledOnce();
  });

  it('chainSecHandlers com ctx.stale: o anti-golpista não roda, o dono roda', async () => {
    const sec = vi.fn(async () => ({ incidents: ['x'] }));
    const owner = vi.fn(async () => ({ note: 'dono' }));
    const h = chainSecHandlers({ 'group.participants': owner } as never, { 'group.participants': sec } as never);
    const r = await h['group.participants']!(participants(Date.now()) as never, { raw: null, stale: true });
    expect(sec).not.toHaveBeenCalled();
    expect(owner).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ note: 'dono' });
  });

  it('webhook WAHA sem timestamp conta como novo (mapper usa "agora")', async () => {
    const raw = joinWebhook();
    const e = mapWahaEvent(raw)!;
    let stale: boolean | undefined;
    await handleWaEvent(e, { handlers: { 'group.participants': async (_e, ctx) => void (stale = ctx.stale) } }, raw);
    expect(stale).toBe(false);
  });

  it('rede de segurança: e.ts novo mas job enfileirado há 11 min → stale (min de e.ts e job.timestamp)', async () => {
    const seen: boolean[] = [];
    const proc = createWaEventsProcessor({
      handlers: { 'group.participants': async (_e, ctx) => void seen.push(ctx.stale) },
    });
    const webhook = joinWebhook();
    await proc({ data: { webhook }, timestamp: Date.now() - 11 * MIN } as never);
    await proc({ data: { webhook }, timestamp: Date.now() } as never);
    expect(seen).toEqual([true, false]);
  });

  it('evento que o mapper não conhece é ignorado', async () => {
    const proc = createWaEventsProcessor({ handlers: {} });
    const r = await proc({ data: { webhook: { event: 'nada.a.ver', session: 's', payload: {} } }, timestamp: Date.now() } as never);
    expect(r).toMatchObject({ handled: false, kind: null });
  });
});
