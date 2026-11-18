import { mapWahaEvent, type WaEngine, type WaEvent, type WahaWebhook } from '@mag/wa-engine';
import { identityOf } from '../src/identity';
import { MemorySecRepo } from '../src/memory-repo';
import type { SecEngine } from '../src/handlers';
import type { SecGroupContext } from '../src/repo';

export const GID = '1203630000000001@g.us';
export const ME = '5511999990001'; // conta da campanha (sessão chip-01)
export const HACKER = '5511999990002';
export const ADMIN_TEAM = '5511999990003';

const T0 = 1792115700;

/** Dados internos de um evento de grupo do GOWS (só o que o anti-golpista lê: autor e tópico). */
const groupData = (): Record<string, unknown> => ({
  JID: GID,
  Notify: 'Teste',
  Sender: `${ME}@lid`,
  SenderPN: `${ME}@s.whatsapp.net`,
  Topic: null,
});

const envelope = (event: string, payload: Record<string, unknown>): WahaWebhook => ({
  id: 'evt-teste',
  timestamp: T0,
  event,
  session: 'chip-01',
  engine: 'GOWS',
  me: { id: `${ME}@c.us`, pushName: 'Conta de teste' },
  payload,
});

/** Webhooks GOWS de exemplo (sintéticos, mesmo formato dos reais), opcionalmente alterados. */
const SAMPLES: Record<string, () => WahaWebhook> = {
  'message.reaction': () =>
    envelope('message.reaction', {
      id: `true_${GID}_3EB0SAMPLE01_${ME}@c.us`,
      timestamp: T0,
      from: GID,
      fromMe: true,
      source: 'api',
      to: `${ME}@c.us`,
      participant: `${ME}@c.us`,
      reaction: { text: '👍', messageId: `true_${GID}_3EB0SAMPLE02_${ME}@c.us` },
    }),
  'group.v2.participants.leave': () =>
    envelope('group.v2.participants', {
      group: { id: GID },
      type: 'leave',
      timestamp: T0,
      participants: [{ id: `${ME}@lid`, pn: null, role: 'left' }],
      _data: groupData(),
    }),
  'group.v2.update': () =>
    envelope('group.v2.update', {
      timestamp: T0,
      group: { id: GID, subject: 'Grupo de teste' },
      _data: {
        ...groupData(),
        Name: { Name: 'Grupo de teste', NameSetBy: `${ME}@lid`, NameSetByPN: `${ME}@s.whatsapp.net` },
      },
    }),
};

export function sample(name: string, patch: (w: WahaWebhook) => void = () => {}): WahaWebhook {
  const w = SAMPLES[name]!();
  patch(w);
  return w;
}

/** message.in em grupo — mesmo envelope GOWS dos samples (payload no formato WAHA `message`). */
export function messageWebhook(from: string, body: string, id = '3EB0HACK0001'): WahaWebhook {
  return sample('message.reaction', (w) => {
    w.event = 'message';
    w.payload = {
      id: `false_${GID}_${id}_${from}@c.us`,
      timestamp: 1792115700,
      from: GID,
      fromMe: false,
      participant: `${from}@c.us`,
      body,
      hasMedia: false,
    };
  });
}

/** Reação (de qualquer membro) à mensagem `id` cujo autor é `author` — sample GOWS real alterado. */
export function reactionWebhook(
  reactor: string,
  author: string,
  id = '3EB0HACK0001',
  fromMe = false,
  emoji = '😮',
): WahaWebhook {
  return sample('message.reaction', (w) => {
    const p = w.payload as Record<string, unknown>;
    p.id = `false_${GID}_3EB0REACT${id}_${reactor}@c.us`;
    p.fromMe = false;
    p.participant = `${reactor}@c.us`;
    p.reaction = { text: emoji, messageId: `${fromMe}_${GID}_${id}_${author}@c.us` };
  });
}

export function promoteWebhook(target: string, author: string): WahaWebhook {
  return sample('group.v2.participants.leave', (w) => {
    const p = w.payload as Record<string, unknown>;
    p.type = 'promote';
    p.participants = [{ id: `${target}@c.us`, pn: null, role: 'admin' }];
    const d = p._data as Record<string, unknown>;
    d.Sender = `${author}@s.whatsapp.net`;
    d.SenderPN = `${author}@s.whatsapp.net`;
  });
}

/** Entrada de participantes (`type: 'join'`) — sample GOWS real alterado; `jids` com sufixo (`@c.us`/`@lid`). */
export function joinWebhook(...jids: string[]): WahaWebhook {
  return sample('group.v2.participants.leave', (w) => {
    const p = w.payload as Record<string, unknown>;
    p.type = 'join';
    p.participants = jids.map((id) => ({ id, pn: null, role: 'participant' }));
  });
}

export function demoteWebhook(target: string, author: string, type: 'demote' | 'remove' = 'demote'): WahaWebhook {
  return sample('group.v2.participants.leave', (w) => {
    const p = w.payload as Record<string, unknown>;
    p.type = type;
    p.participants = [{ id: `${target}@c.us`, pn: null, role: 'participant' }];
    const d = p._data as Record<string, unknown>;
    d.Sender = `${author}@s.whatsapp.net`;
    d.SenderPN = `${author}@s.whatsapp.net`;
  });
}

export function subjectWebhook(subject: string, author: string): WahaWebhook {
  return sample('group.v2.update', (w) => {
    const p = w.payload as { group: { subject: string }; _data: Record<string, unknown> };
    p.group.subject = subject;
    p._data.Sender = `${author}@lid`;
    p._data.SenderPN = `${author}@s.whatsapp.net`;
  });
}

export const ev = <K extends WaEvent['kind']>(w: WahaWebhook) => mapWahaEvent(w)! as Extract<WaEvent, { kind: K }>;

export function context(over: Partial<SecGroupContext['campaign']> = {}, settings = { announce: true }): SecGroupContext {
  return {
    group: {
      id: 'g1',
      gid: GID,
      name: 'Lançamento #1',
      description: 'Grupo oficial',
      inviteCode: 'ABC',
      settings,
      waAccountId: 'acc-main',
    },
    campaign: {
      id: 'c1',
      name: 'Lançamento',
      antiHacker: { enabled: true },
      onlyAdminsSpeak: true,
      autoDenyBlocked: true,
      templateAdmins: [],
      ...over,
    },
    accounts: [
      { id: 'acc-main', sessionName: 'chip-01', jid: `${ME}@c.us`, lid: null, status: 'active', role: 'both' },
      { id: 'acc-spy', sessionName: 'spy1', jid: '5511999990004@c.us', lid: null, status: 'active', role: 'spy' },
    ],
  };
}

export function setup(over?: Partial<SecGroupContext['campaign']>, settings?: { announce: boolean }) {
  const repo = new MemorySecRepo();
  repo.groups.set(GID, context(over, settings));
  repo.adminNumbers = [identityOf(ADMIN_TEAM)];
  const calls: { op: string; session: string; args: unknown[] }[] = [];
  const rec =
    (op: string) =>
    async (session: string, ...args: unknown[]) => {
      calls.push({ op, session, args });
      const jids = args[1];
      return Array.isArray(jids) ? jids.map((jid) => ({ jid, ok: true })) : undefined;
    };
  const engine = {
    deleteMessage: rec('deleteMessage'),
    removeParticipants: rec('removeParticipants'),
    addParticipants: rec('addParticipants'),
    promote: rec('promote'),
    demote: rec('demote'),
    setSubject: rec('setSubject'),
    setDescription: rec('setDescription'),
    // anti-impostor: padrão sem foto/nome e grupo sem participantes; o teste troca o que precisar
    getProfilePicture: async () => null,
    getContactName: async () => null,
    getGroup: async (_session: string, gid: string) => ({
      gid,
      subject: '',
      participants: [],
      announce: settings ? settings.announce : (over?.onlyAdminsSpeak ?? true), // ao vivo = o que o teste montou
    }),
  } as unknown as SecEngine & Required<Pick<WaEngine, 'getProfilePicture' | 'getContactName'>>;
  return { repo, engine, calls };
}
