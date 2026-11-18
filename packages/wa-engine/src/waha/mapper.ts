import type { EventParticipant, WaEvent } from '../types';

/** Envelope de webhook WAHA (https://waha.devlike.pro/docs/how-to/events/). */
export type WahaWebhook = {
  id?: string;
  timestamp?: number;
  event: string;
  session: string;
  me?: { id: string; pushName?: string };
  payload: Record<string, unknown>;
  engine?: string;
};

type Obj = Record<string, unknown>;

/** WAHA usa segundos (às vezes fracionados) ou ms; normaliza p/ ms. */
export function toMs(ts: unknown, fallback = Date.now()): number {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return fallback;
  return ts < 1e12 ? Math.round(ts * 1000) : Math.round(ts);
}

function participant(id: unknown, pn?: unknown): EventParticipant {
  const raw = String(id ?? '');
  const phoneJid = typeof pn === 'string' && pn ? pn : undefined;
  if (raw.endsWith('@lid')) return { jid: phoneJid ?? raw, lid: raw };
  return { jid: raw };
}

const PARTICIPANT_ACTION: Record<string, 'add' | 'remove' | 'promote' | 'demote'> = {
  join: 'add',
  add: 'add',
  leave: 'remove',
  remove: 'remove',
  promote: 'promote',
  demote: 'demote',
};

function groupId(p: Obj): string {
  const g = p.group as Obj | undefined;
  return String(g?.id ?? p.id ?? '');
}

/**
 * Normaliza um webhook WAHA em WaEvent. Retorna `null` p/ eventos ignorados
 * (ex.: message.any, presence).
 */
export function mapWahaEvent(w: WahaWebhook, now = Date.now()): WaEvent | null {
  const p = (w.payload ?? {}) as Obj;
  const session = w.session;
  const envTs = toMs(w.timestamp, now);

  switch (w.event) {
    case 'session.status':
      return {
        kind: 'session.status',
        session,
        status: String(p.status),
        reason: typeof p.reason === 'string' ? p.reason : undefined,
        ts: envTs,
      };

    case 'message': {
      const from = String(p.from ?? '');
      return {
        kind: 'message.in',
        session,
        id: String(p.id ?? ''),
        chatId: from,
        from: String(p.participant ?? from),
        fromMe: Boolean(p.fromMe),
        body: typeof p.body === 'string' ? p.body : undefined,
        hasMedia: Boolean(p.hasMedia),
        ts: toMs(p.timestamp, envTs),
      };
    }

    // ack de mensagem em GRUPO só chega como `message.ack.group` (1 por participante); `message.ack` = PV
    case 'message.ack':
    case 'message.ack.group':
      return {
        kind: 'message.ack',
        session,
        id: String(p.id ?? ''),
        chatId: String(p.fromMe ? (p.to ?? p.from) : p.from),
        ...(typeof p.participant === 'string' && p.participant ? { participant: p.participant } : {}),
        ack: Number(p.ack ?? 0),
        ackName: typeof p.ackName === 'string' ? p.ackName : undefined,
        ts: toMs(p.timestamp, envTs),
      };

    case 'message.reaction': {
      const r = (p.reaction ?? {}) as Obj;
      const from = String(p.from ?? '');
      return {
        kind: 'message.reaction',
        session,
        id: String(p.id ?? ''),
        chatId: from,
        from: String(p.participant ?? from),
        messageId: String(r.messageId ?? ''),
        emoji: String(r.text ?? ''),
        ts: toMs(p.timestamp, envTs),
      };
    }

    case 'group.v2.join':
    case 'group.v2.leave': {
      const g = (p.group ?? {}) as Obj;
      return {
        kind: 'group.self',
        session,
        gid: groupId(p),
        action: w.event === 'group.v2.join' ? 'join' : 'leave',
        subject: typeof g.subject === 'string' ? g.subject : undefined,
        ts: toMs(p.timestamp, envTs),
      };
    }

    case 'group.v2.participants': {
      const action = PARTICIPANT_ACTION[String(p.type)];
      if (!action) return null;
      const list = (p.participants ?? []) as Obj[];
      return {
        kind: 'group.participants',
        session,
        gid: groupId(p),
        action,
        participants: list.map((x) => participant(x.id, x.pn ?? x.phoneNumber)),
        actor: typeof p.author === 'string' ? p.author : undefined,
        ts: toMs(p.timestamp, envTs),
      };
    }

    case 'group.v2.participants.join-request': {
      const action = String(p.action);
      if (action !== 'created' && action !== 'rejected' && action !== 'revoked') return null;
      return {
        kind: 'group.join-request',
        session,
        gid: groupId(p),
        participant: participant(p.requesterId, p.requesterPn),
        action,
        method: (p.requestMethod as string | null | undefined) ?? null,
        ts: toMs(p.timestamp, envTs),
      };
    }

    case 'group.v2.update': {
      const g = (p.group ?? {}) as Obj;
      const announce = g.announce ?? g.isAnnounce ?? g.IsAnnounce;
      return {
        kind: 'group.update',
        session,
        gid: groupId(p),
        subject: typeof g.subject === 'string' ? g.subject : undefined,
        description: typeof g.description === 'string' ? g.description : undefined,
        announce: typeof announce === 'boolean' ? announce : undefined,
        inviteCode: typeof g.inviteCode === 'string' ? g.inviteCode : undefined,
        ts: toMs(p.timestamp, envTs),
      };
    }

    case 'poll.vote': {
      const vote = (p.vote ?? {}) as Obj;
      const poll = (p.poll ?? {}) as Obj;
      return {
        kind: 'poll.vote',
        session,
        pollId: String(poll.id ?? ''),
        chatId: String(poll.to ?? ''),
        voter: String(vote.participant ?? vote.from ?? ''),
        selectedOptions: Array.isArray(vote.selectedOptions) ? vote.selectedOptions.map(String) : [],
        ts: toMs(vote.timestamp, envTs),
      };
    }

    default:
      return null;
  }
}

/** Chave de dedup do webhook (vira o `jobId` da fila): id do envelope quando houver, senão hash estável. */
export function dedupKeyOf(w: WahaWebhook): string {
  if (w.id) return `${w.session}:${w.id}`;
  const p = w.payload ?? {};
  const inner = (p as Obj).id ?? JSON.stringify(p);
  return `${w.session}:${w.event}:${String(w.timestamp ?? '')}:${String(inner)}`;
}
