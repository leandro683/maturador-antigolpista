import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Security from '@mag/module-security';
import { eq } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { groupParticipants, groups } from '@mag/db/schema';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import { addChip, addPair, confirmPair, type WarmupDeps } from '@mag/module-warmup';
import { FakeEngine } from '@mag/wa-engine/fake';
import { seedCampaign, seedAccount } from './helpers';

// Troca só o anti-golpista por espiões que anotam a ordem de chamada; o resto (maturador, dono, banco) é real.
const calls: string[] = [];
let seenAtSec: () => Promise<unknown> = async () => undefined;
let secAccepts = true;
vi.mock('@mag/module-security', async (orig) => ({
  ...(await orig<typeof Security>()),
  createSecHandlers: () => ({
    'message.in': async () => void calls.push('sec:message.in'),
    'group.participants': async () => {
      calls.push('sec:group.participants');
      await seenAtSec();
    },
    'group.update': async () => {
      calls.push('sec:group.update');
      await seenAtSec();
      return { handled: true, accepted: secAccepts };
    },
  }),
}));

const { buildHandlers } = await import('../src/handlers');
type Handler = (e: unknown, ctx: { raw: unknown; stale: boolean }) => Promise<unknown>;

describe.skipIf(!PG_URL)('handlers do wa-events (Postgres real)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  const engine = new FakeEngine();
  const schedule = vi.fn(async () => {});
  let h: Record<string, Handler>;

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
    h = buildHandlers({ db, engine, warmup: { db, schedule } as unknown as WarmupDeps, log: () => {} }) as never;
  });
  afterAll(async () => drop?.());
  beforeEach(() => {
    calls.length = 0;
    seenAtSec = async () => undefined;
    secAccepts = true;
  });

  const ctx = { raw: null, stale: false };

  it('fala entre os dois chips de um par do maturador é consumida: o anti-golpista não vê', async () => {
    const a = await seedAccount(db, engine);
    const b = await seedAccount(db, engine);
    await addChip(db, a.id);
    await addChip(db, b.id);
    const pairId = await addPair(db, a.id, b.id);
    await confirmPair(db, pairId);
    const msg = (chatId: string) => ({
      kind: 'message.in',
      session: a.sessionName,
      id: 'm1',
      chatId,
      from: chatId,
      fromMe: false,
      body: 'oi',
      hasMedia: false,
      ts: Date.now(),
    });
    expect(await h['message.in']!(msg(b.jid!), ctx)).toEqual({ handled: true });
    expect(calls).toEqual([]);
    // número de fora do par segue o caminho normal: passa pelo anti-golpista
    await h['message.in']!(msg('5511999990077@c.us'), ctx);
    expect(calls).toEqual(['sec:message.in']);
  });

  it('group.participants: o anti-golpista roda antes do dono, que grava o participante', async () => {
    const t = await seedCampaign(db, engine, 1);
    const rows = () => db.select().from(groupParticipants).where(eq(groupParticipants.groupId, t.gs[0]!.id));
    let seen = -1;
    seenAtSec = async () => void (seen = (await rows()).length);
    const e = {
      kind: 'group.participants',
      session: t.acc.sessionName,
      gid: t.gs[0]!.gid,
      action: 'add',
      participants: [{ jid: '5511999990042@c.us' }],
      ts: Date.now(),
    };
    expect(await h['group.participants']!(e, ctx)).toMatchObject({ handled: true });
    expect(calls).toEqual(['sec:group.participants']);
    expect(seen).toBe(0); // na hora do anti-golpista o dono ainda não tinha gravado
    expect((await rows()).map((r) => r.phone)).toEqual(['+5511999990042']);
    const [g] = await db.select().from(groups).where(eq(groups.id, t.gs[0]!.id));
    expect(g!.participantsAmount).toBe(1);
  });

  it('group.update: com o aval do anti-golpista grava o nome (e descrição, convite, só admins) depois dele', async () => {
    const t = await seedCampaign(db, engine, 1);
    const gid = t.gs[0]!.gid;
    await db.update(groups).set({ settings: { guardado: true } }).where(eq(groups.gid, gid));
    const read = async () => (await db.select().from(groups).where(eq(groups.gid, gid)))[0]!;
    let nameAtSec = '';
    seenAtSec = async () => void (nameAtSec = (await read()).name);
    const e = { kind: 'group.update', session: t.acc.sessionName, gid, subject: 'Novo nome', description: 'Nova descrição', announce: true, inviteCode: 'ABC123', ts: Date.now() };
    await h['group.update']!(e, ctx);
    expect(calls).toEqual(['sec:group.update']);
    expect(nameAtSec).toBe('G0'); // o anti-golpista ainda viu o nome anterior
    expect(await read()).toMatchObject({
      name: 'Novo nome',
      description: 'Nova descrição',
      inviteCode: 'ABC123',
      settings: { guardado: true, announce: true },
    });
    // evento atrasado não sobrescreve nada
    await h['group.update']!({ ...e, subject: 'Velho' }, { raw: null, stale: true });
    expect((await read()).name).toBe('Novo nome');
    // grupo de fora das campanhas
    expect(await h['group.update']!({ ...e, gid: '1203630000000099@g.us' }, ctx)).toMatchObject({ handled: false });
  });

  it('group.update: sem o aval do anti-golpista, nome e descrição ficam; convite e só admins entram', async () => {
    const t = await seedCampaign(db, engine, 1);
    const gid = t.gs[0]!.gid;
    secAccepts = false;
    const e = { kind: 'group.update', session: t.acc.sessionName, gid, subject: 'Golpe', description: 'Pix aqui', announce: true, inviteCode: 'https://chat.whatsapp.com/NOVO1', ts: Date.now() };
    await h['group.update']!(e, ctx);
    const [g] = await db.select().from(groups).where(eq(groups.gid, gid));
    expect(g).toMatchObject({ name: 'G0', description: null, inviteCode: 'NOVO1', settings: { announce: true } });
  });

  it('group.update: o anti-golpista que falha (lança) também não dá aval ao nome', async () => {
    const t = await seedCampaign(db, engine, 1);
    const gid = t.gs[0]!.gid;
    seenAtSec = async () => {
      throw new Error('banco caiu');
    };
    const e = { kind: 'group.update', session: t.acc.sessionName, gid, subject: 'Golpe', announce: true, ts: Date.now() };
    await h['group.update']!(e, ctx);
    const [g] = await db.select().from(groups).where(eq(groups.gid, gid));
    expect(g).toMatchObject({ name: 'G0', settings: { announce: true } });
  });
});
