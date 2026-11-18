import { describe, expect, it } from 'vitest';
import { DEFAULT_WEBHOOK_EVENTS } from '../src/waha/client';
import { dedupKeyOf, mapWahaEvent, toMs, type WahaWebhook } from '../src/waha/mapper';

const NOW = 1_800_000_000_000;
const S = 'chip-01';
const GROUP = '1203630000000001@g.us';
const GROUP_2 = '1203630000000002@g.us';
const PHONE = (n: number) => `55119999900${String(n).padStart(2, '0')}@c.us`;
const LID = (n: number) => `10000000000000${n}@lid`;

/** Webhooks de WAHA (GOWS) no formato de https://waha.devlike.pro/docs/how-to/events/, com ids falsos. */
const f = {
  'session.status': {
    id: 'evt_01',
    timestamp: 1700000002,
    event: 'session.status',
    session: S,
    payload: { status: 'WORKING' },
  },
  message: {
    event: 'message',
    session: S,
    payload: {
      id: `false_${GROUP}_3EB0AAAA_${PHONE(0)}`,
      timestamp: 1710481111,
      from: GROUP,
      participant: PHONE(0),
      fromMe: false,
      body: 'oi',
      hasMedia: false,
    },
  },
  'message.ack': {
    event: 'message.ack',
    session: S,
    payload: { id: `true_${PHONE(1)}_3EB0BBBB`, from: PHONE(2), to: PHONE(1), fromMe: true, ack: 3, ackName: 'READ' },
  },
  'message.reaction': {
    event: 'message.reaction',
    session: S,
    payload: {
      id: `false_${PHONE(1)}_3EB0CCCC`,
      timestamp: 1710481111.853,
      from: PHONE(1),
      reaction: { text: '🙏', messageId: `true_${PHONE(1)}_3EB0DDDD` },
    },
  },
  'group.v2.join': {
    event: 'group.v2.join',
    session: S,
    payload: { timestamp: 1666943582, group: { id: GROUP, subject: 'Turma #1' } },
  },
  'group.v2.leave': {
    event: 'group.v2.leave',
    session: S,
    payload: { timestamp: 1666943582, group: { id: GROUP, subject: 'Turma #1' } },
  },
  'group.v2.participants': {
    event: 'group.v2.participants',
    session: S,
    payload: {
      timestamp: 1666943582,
      type: 'join',
      group: { id: GROUP },
      participants: [{ id: PHONE(0) }, { id: LID(1) }],
    },
  },
  'group.v2.participants.join-request': {
    event: 'group.v2.participants.join-request',
    session: S,
    payload: {
      timestamp: 1666943582,
      group: { id: GROUP },
      action: 'created',
      requesterId: LID(2),
      requesterPn: PHONE(3),
      requestMethod: 'invite_link',
    },
  },
  'group.v2.update': {
    event: 'group.v2.update',
    session: S,
    payload: { timestamp: 1666943582, group: { id: GROUP_2, subject: 'Novo nome do grupo' } },
  },
  'poll.vote': {
    event: 'poll.vote',
    session: S,
    timestamp: 1692861427,
    payload: {
      vote: { participant: PHONE(4), selectedOptions: ['Ótimo'], timestamp: 1692861427 },
      poll: { id: `true_${PHONE(5)}_BAE5F2EF5C69001E`, to: PHONE(5) },
    },
  },
} satisfies Record<string, WahaWebhook>;

describe('mapWahaEvent (shapes de waha.devlike.pro/docs/how-to/events)', () => {
  it('session.status', () => {
    expect(mapWahaEvent(f['session.status'], NOW)).toEqual({
      kind: 'session.status',
      session: S,
      status: 'WORKING',
      reason: undefined,
      ts: 1700000002000,
    });
  });

  it('message → message.in com participant como remetente em grupo', () => {
    expect(mapWahaEvent(f.message, NOW)).toMatchObject({
      kind: 'message.in',
      chatId: GROUP,
      from: PHONE(0),
      fromMe: false,
      body: 'oi',
      ts: 1710481111000,
    });
  });

  it('message no privado: remetente é o próprio chat; ts do envelope quando o payload não traz', () => {
    const w: WahaWebhook = {
      event: 'message',
      session: S,
      timestamp: 1700000000,
      payload: { id: 'm1', from: PHONE(1), fromMe: false, body: 'oi', hasMedia: true },
    };
    expect(mapWahaEvent(w, NOW)).toMatchObject({
      kind: 'message.in',
      chatId: PHONE(1),
      from: PHONE(1),
      hasMedia: true,
      ts: 1700000000000,
    });
  });

  it('message.ack.group (GOWS manda ack de grupo só neste evento) → message.ack com participant', () => {
    const w: WahaWebhook = {
      event: 'message.ack.group',
      session: S,
      engine: 'GOWS',
      payload: {
        id: `true_${GROUP}_3EB028D7D55BDC0343E30E_${LID(9)}`,
        from: GROUP,
        participant: LID(9),
        fromMe: true,
        ack: 3,
        ackName: 'READ',
      },
    };
    expect(mapWahaEvent(w, NOW)).toMatchObject({
      kind: 'message.ack',
      chatId: GROUP,
      participant: LID(9),
      ack: 3,
    });
  });

  it('DEFAULT_WEBHOOK_EVENTS assina message.ack.group e todo evento que o mapper traduz', () => {
    expect(DEFAULT_WEBHOOK_EVENTS).toContain('message.ack.group');
    for (const w of Object.values(f)) expect(DEFAULT_WEBHOOK_EVENTS, w.event).toContain(w.event);
  });

  it('message.ack (privado): enviada por mim → chat é o destinatário; recebida → chat é o remetente', () => {
    expect(mapWahaEvent(f['message.ack'], NOW)).toMatchObject({
      kind: 'message.ack',
      ack: 3,
      ackName: 'READ',
      chatId: PHONE(1),
      ts: NOW,
    });
    const recebida: WahaWebhook = { ...f['message.ack'], payload: { ...f['message.ack'].payload, fromMe: false } };
    expect(mapWahaEvent(recebida, NOW)).toMatchObject({ chatId: PHONE(2) });
  });

  it('message.reaction (segundos fracionados → ms)', () => {
    expect(mapWahaEvent(f['message.reaction'], NOW)).toMatchObject({
      kind: 'message.reaction',
      emoji: '🙏',
      messageId: `true_${PHONE(1)}_3EB0DDDD`,
      ts: 1710481111853,
    });
  });

  it('group.v2.join / leave → group.self', () => {
    expect(mapWahaEvent(f['group.v2.join'], NOW)).toEqual({
      kind: 'group.self',
      session: S,
      gid: GROUP,
      action: 'join',
      subject: 'Turma #1',
      ts: 1666943582000,
    });
    expect(mapWahaEvent(f['group.v2.leave'], NOW)).toMatchObject({ kind: 'group.self', action: 'leave' });
  });

  it('group.v2.participants join → add, LID preservado', () => {
    expect(mapWahaEvent(f['group.v2.participants'], NOW)).toEqual({
      kind: 'group.participants',
      session: S,
      gid: GROUP,
      action: 'add',
      participants: [{ jid: PHONE(0) }, { jid: LID(1), lid: LID(1) }],
      actor: undefined,
      ts: 1666943582000,
    });
  });

  it('group.v2.participants: LID com telefone (pn) usa o telefone como jid e guarda o LID; author vira actor', () => {
    const w: WahaWebhook = {
      ...f['group.v2.participants'],
      payload: {
        ...f['group.v2.participants'].payload,
        author: PHONE(7),
        participants: [{ id: LID(1), pn: PHONE(2) }, { id: LID(3), phoneNumber: PHONE(4) }],
      },
    };
    expect(mapWahaEvent(w, NOW)).toMatchObject({
      actor: PHONE(7),
      participants: [
        { jid: PHONE(2), lid: LID(1) },
        { jid: PHONE(4), lid: LID(3) },
      ],
    });
  });

  it('group.v2.participants promote / demote / leave / remove', () => {
    for (const [type, action] of [
      ['promote', 'promote'],
      ['demote', 'demote'],
      ['leave', 'remove'],
      ['remove', 'remove'],
    ] as const) {
      const w: WahaWebhook = { ...f['group.v2.participants'], payload: { ...f['group.v2.participants'].payload, type } };
      expect(mapWahaEvent(w, NOW), type).toMatchObject({ kind: 'group.participants', action });
    }
  });

  it('participants type desconhecido → null', () => {
    const w = structuredClone(f['group.v2.participants']) as WahaWebhook;
    w.payload.type = 'weird';
    expect(mapWahaEvent(w, NOW)).toBeNull();
  });

  it('join-request usa requesterPn como jid e requesterId como lid', () => {
    expect(mapWahaEvent(f['group.v2.participants.join-request'], NOW)).toEqual({
      kind: 'group.join-request',
      session: S,
      gid: GROUP,
      participant: { jid: PHONE(3), lid: LID(2) },
      action: 'created',
      method: 'invite_link',
      ts: 1666943582000,
    });
  });

  it('join-request com action desconhecida → null', () => {
    const w: WahaWebhook = {
      ...f['group.v2.participants.join-request'],
      payload: { ...f['group.v2.participants.join-request'].payload, action: 'weird' },
    };
    expect(mapWahaEvent(w, NOW)).toBeNull();
  });

  it('group.v2.update', () => {
    expect(mapWahaEvent(f['group.v2.update'], NOW)).toMatchObject({
      kind: 'group.update',
      gid: GROUP_2,
      subject: 'Novo nome do grupo',
    });
  });

  it('group.v2.update: announce aceita as 3 grafias do WAHA e ignora o que não é booleano', () => {
    const upd = (g: Record<string, unknown>) =>
      mapWahaEvent({ event: 'group.v2.update', session: S, payload: { group: { id: GROUP_2, ...g } } }, NOW);
    expect(upd({ announce: true })).toMatchObject({ announce: true });
    expect(upd({ isAnnounce: false })).toMatchObject({ announce: false });
    expect(upd({ IsAnnounce: true })).toMatchObject({ announce: true });
    expect(upd({ announce: 'sim' })).toMatchObject({ announce: undefined });
  });

  it('poll.vote', () => {
    expect(mapWahaEvent(f['poll.vote'], NOW)).toEqual({
      kind: 'poll.vote',
      session: S,
      pollId: `true_${PHONE(5)}_BAE5F2EF5C69001E`,
      chatId: PHONE(5),
      voter: PHONE(4),
      selectedOptions: ['Ótimo'],
      ts: 1692861427000,
    });
  });

  it('evento não mapeado → null', () => {
    expect(mapWahaEvent({ event: 'presence.update', session: 's', payload: {} }, NOW)).toBeNull();
  });

  it('toMs / dedupKeyOf', () => {
    expect(toMs(1666943582)).toBe(1666943582000);
    expect(toMs(1700000002000)).toBe(1700000002000);
    expect(toMs(undefined, 5)).toBe(5);
    expect(dedupKeyOf(f['session.status'])).toBe(`${S}:evt_01`);
    expect(dedupKeyOf(f['message.ack'])).toContain('message.ack');
  });
});
