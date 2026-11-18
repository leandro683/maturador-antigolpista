import type {
  ChatMessage,
  EngineCapabilities,
  EngineSession,
  GroupInfo,
  GroupParticipant,
  GroupSettings,
  JoinRequest,
  MessageBlock,
  PerJidResult,
  SendOptions,
  SessionStatus,
  WaEngine,
} from '../types';
import { QrCycle } from './sessions';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type WahaClientOptions = {
  baseUrl: string;
  apiKey?: string;
  fetch?: FetchLike;
  /** registrado em cada sessão criada (POST /api/sessions config.webhooks) */
  webhook?: { url: string; hmacKey?: string; events?: string[] };
  qrCycle?: QrCycle;
  /** Tempo máximo por requisição HTTP (ms). Sem isso uma chamada pendurada trava o reconcile inteiro. */
  timeoutMs?: number;
  /** Tempo máximo p/ envio de mídia (imagem/vídeo/arquivo/voz): o WAHA baixa o arquivo (até 50 MB), converte e sobe
   *  p/ o WhatsApp dentro da mesma chamada, o que passa fácil de 30 s num vídeo grande. */
  mediaTimeoutMs?: number;
};

export const DEFAULT_WAHA_TIMEOUT_MS = 30_000;
export const DEFAULT_WAHA_MEDIA_TIMEOUT_MS = 600_000; // 10 min: arquivos grandes (até 300 MB) levam bem mais que o padrão

export const DEFAULT_WEBHOOK_EVENTS = [
  'session.status',
  'message',
  'message.ack',
  // GOWS só emite recibos de GRUPO neste evento (`message.ack` cobre só o privado)
  'message.ack.group',
  'message.reaction',
  'group.v2.join',
  'group.v2.leave',
  'group.v2.participants',
  'group.v2.participants.join-request',
  'group.v2.update',
  'poll.vote',
];

/** Capacidades honestas do GOWS. */
export const GOWS_CAPABILITIES: EngineCapabilities = {
  communities: false,
  polls: true,
  events: true,
  joinRequests: true,
  // WAHA não tem temporária por mensagem nem gifPlayback no GOWS; vCard via /api/sendContactVcard (não testado em chip real)
  ephemeral: false,
  gif: false,
  vcard: true,
  // WAHA documenta o PUT de edição no GOWS; não validado em chip real (501 vira falha legível no item)
  editMessage: true,
  // `sendVideo` com `asNote` (vídeo instantâneo) documentado; figurinha/botões/lista/Pix não existem
  videoNote: true,
  sticker: false,
  buttons: false,
  list: false,
  pix: false,
};

/** `file` do WAHA: base64 (`data`) quando presente, senão URL. */
function fileOf(b: { url: string; data?: string; mimetype?: string }, filename?: string): Obj {
  const f: Obj = b.data ? { data: b.data } : { url: b.url };
  if (b.mimetype) f.mimetype = b.mimetype;
  if (filename) f.filename = filename;
  return f;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** WAMessage do WAHA → ChatMessage (null se não der p/ saber id/autor). */
export function chatMessageOf(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Obj;
  const id = idOf(m.id) ?? str(m.id);
  const info = ((m._data as Obj | undefined)?.Info ?? {}) as Obj;
  const from = str(m.participant) ?? str(m.author) ?? str(info.Sender) ?? str(m.from);
  if (!id || !from) return null;
  const alt = [str(info.SenderAlt), str(info.Sender)].find((x) => x && x !== from);
  const ts = Number(m.timestamp ?? 0);
  return {
    id,
    from,
    ...(alt ? { fromAlt: alt } : {}),
    fromMe: Boolean(m.fromMe),
    ...(typeof m.body === 'string' ? { body: m.body } : {}),
    hasMedia: Boolean(m.hasMedia),
    ts: ts > 1e12 ? ts : ts * 1000,
  };
}

export class WahaHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`WAHA ${status} em ${path}: ${body.slice(0, 200)}`);
    this.name = 'WahaHttpError';
  }
}

export class WaNotSupportedError extends Error {
  constructor(feature: string) {
    super(`não suportado pelo engine: ${feature}`);
    this.name = 'WaNotSupportedError';
  }
}

export function wahaConfigFromEnv(env: Record<string, string | undefined> = process.env): WahaClientOptions {
  const baseUrl = env.WAHA_URL;
  if (!baseUrl) throw new Error('WAHA_URL ausente');
  return { baseUrl, apiKey: env.WAHA_API_KEY };
}

const enc = encodeURIComponent;
type Obj = Record<string, unknown>;

/** WAHA às vezes devolve id como string, às vezes `{ _serialized }`. */
function idOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Obj;
    if (typeof o._serialized === 'string') return o._serialized;
    if (typeof o.id === 'string') return o.id;
    if (o.id && typeof o.id === 'object') return idOf(o.id);
    if (typeof o.JID === 'string') return o.JID;
    if (typeof o.gid === 'string') return o.gid;
  }
  return undefined;
}

function toParticipant(p: Obj): GroupParticipant {
  // GOWS: { JID, LID?, PhoneNumber?, IsAdmin, IsSuperAdmin } · outros: { id, role }
  const role = typeof p.role === 'string' ? p.role : undefined;
  const jidRaw = (p.PhoneNumber as string) || (p.JID as string) || idOf(p.id) || '';
  const lid = (p.LID as string) || (jidRaw.endsWith('@lid') ? jidRaw : undefined);
  return {
    jid: jidRaw,
    lid: lid || undefined,
    isAdmin: Boolean(p.IsAdmin ?? p.isAdmin ?? (role === 'admin' || role === 'superadmin')),
    isSuperAdmin: Boolean(p.IsSuperAdmin ?? p.isSuperAdmin ?? role === 'superadmin'),
  };
}

export function normalizeGroup(raw: Obj): GroupInfo {
  const parts = (raw.Participants ?? raw.participants ?? []) as Obj[];
  return {
    gid: idOf(raw.JID ?? raw.id) ?? '',
    subject: String(raw.Name ?? raw.subject ?? raw.name ?? ''),
    description: (raw.Topic ?? raw.description ?? undefined) as string | undefined,
    inviteCode: (raw.inviteCode ?? undefined) as string | undefined,
    announce: (raw.IsAnnounce ?? raw.announce ?? undefined) as boolean | undefined,
    locked: (raw.IsLocked ?? raw.restrict ?? undefined) as boolean | undefined,
    approvalMode: (raw.IsJoinApprovalRequired ?? raw.approvalMode ?? undefined) as boolean | undefined,
    participants: parts.map(toParticipant),
  };
}

function perJid(jids: string[], res: unknown): PerJidResult[] {
  if (!Array.isArray(res)) return jids.map((jid) => ({ jid, ok: true }));
  return jids.map((jid) => {
    const hit = (res as Obj[]).find((r) => [idOf(r.requesterId), idOf(r.JID), idOf(r.id)].includes(jid));
    if (!hit) return { jid, ok: true };
    const err = (hit.error ?? hit.Error) as string | undefined;
    const ok = hit.success !== false && !err && (hit.status === undefined || Number(hit.status) < 400);
    return ok ? { jid, ok } : { jid, ok, error: err ?? String(hit.status ?? 'failed') };
  });
}

/** Adapter WAHA (engine GOWS) da interface WaEngine via HTTP API. */
export class WahaClient implements WaEngine {
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  readonly qrCycle: QrCycle;

  constructor(private readonly opts: WahaClientOptions) {
    this.fetchFn = opts.fetch ?? ((i, init) => fetch(i, init));
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.qrCycle = opts.qrCycle ?? new QrCycle();
  }

  private async req<T = unknown>(method: string, path: string, body?: unknown, timeout?: number): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.opts.apiKey) headers['X-Api-Key'] = this.opts.apiKey;
    const timeoutMs = timeout ?? this.opts.timeoutMs ?? DEFAULT_WAHA_TIMEOUT_MS;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
      text = await res.text();
    } catch (e) {
      if (ac.signal.aborted) throw new WahaHttpError(408, path, `timeout após ${timeoutMs} ms`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new WahaHttpError(res.status, path, text);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  // ── sessões ─────────────────────────────────────────────
  async createSession(name: string) {
    const config: Obj = {};
    if (this.opts.webhook) {
      config.webhooks = [
        {
          url: this.opts.webhook.url,
          events: this.opts.webhook.events ?? DEFAULT_WEBHOOK_EVENTS,
          ...(this.opts.webhook.hmacKey ? { hmac: { key: this.opts.webhook.hmacKey } } : {}),
        },
      ];
    }
    await this.req('POST', '/api/sessions', { name, start: false, config });
  }
  async listSessions(): Promise<EngineSession[]> {
    const r = await this.req<Obj[]>('GET', '/api/sessions?all=true');
    return (Array.isArray(r) ? r : []).map((x) => {
      const me = (x.me ?? null) as Obj | null;
      const id = me ? idOf(me.id) : undefined;
      return {
        name: String(x.name ?? ''),
        status: String(x.status ?? 'STOPPED'),
        phone: id && /^\d+@c\.us$/.test(id) ? `+${id.split('@')[0]}` : null,
        ...(typeof me?.pushName === 'string' ? { pushName: me.pushName } : {}),
      };
    });
  }
  async startSession(name: string) {
    await this.req('POST', `/api/sessions/${enc(name)}/start`);
  }
  async stopSession(name: string) {
    await this.req('POST', `/api/sessions/${enc(name)}/stop`);
  }
  async logoutSession(name: string) {
    await this.req('POST', `/api/sessions/${enc(name)}/logout`);
  }
  async deleteSession(name: string) {
    await this.req('DELETE', `/api/sessions/${enc(name)}`);
  }
  async getQr(name: string) {
    const attempt = this.qrCycle.next(name);
    const r = await this.req<{ mimetype?: string; data?: string } | string>(
      'GET',
      `/api/${enc(name)}/auth/qr?format=image`,
    );
    const image =
      typeof r === 'string' ? r : `data:${r.mimetype ?? 'image/png'};base64,${r.data ?? ''}`;
    return { image, attempt };
  }
  async getStatus(name: string) {
    const r = await this.req<{ status: SessionStatus }>('GET', `/api/sessions/${enc(name)}`);
    return r.status;
  }
  async getMe(name: string) {
    const r = await this.req<Obj>('GET', `/api/sessions/${enc(name)}/me`);
    return {
      jid: idOf(r.id) ?? '',
      lid: (r.lid as string | undefined) ?? undefined,
      pushName: String(r.pushName ?? ''),
      platform: (r.platform as string | undefined) ?? undefined,
    };
  }

  // ── grupos ──────────────────────────────────────────────
  private g(name: string, gid: string, rest = '') {
    return `/api/${enc(name)}/groups/${enc(gid)}${rest}`;
  }

  async createGroup(name: string, input: { subject: string; participants: string[] }) {
    const r = await this.req<Obj>('POST', `/api/${enc(name)}/groups`, {
      name: input.subject,
      participants: input.participants.map((id) => ({ id })),
    });
    const gid = idOf(r.JID ?? r.gid ?? r.id);
    if (!gid) throw new WahaHttpError(500, 'createGroup', 'resposta sem gid');
    const inviteCode = await this.getInviteCode(name, gid);
    return { gid, inviteCode };
  }
  async getGroup(name: string, gid: string) {
    return normalizeGroup(await this.req<Obj>('GET', this.g(name, gid)));
  }
  async listGroups(name: string) {
    const r = await this.req<Obj[] | Record<string, Obj>>('GET', `/api/${enc(name)}/groups`);
    return (Array.isArray(r) ? r : Object.values(r ?? {})).map((raw) => normalizeGroup(raw));
  }
  async setSubject(name: string, gid: string, subject: string) {
    await this.req('PUT', this.g(name, gid, '/subject'), { subject });
  }
  async setDescription(name: string, gid: string, description: string) {
    await this.req('PUT', this.g(name, gid, '/description'), { description });
  }
  async setPicture(name: string, gid: string, url: string) {
    await this.req('PUT', this.g(name, gid, '/picture'), { file: { url } });
  }
  async setSettings(name: string, gid: string, s: GroupSettings) {
    if (s.ephemeralSec !== undefined) throw new WaNotSupportedError('ephemeral em grupo via WAHA');
    if (s.announce !== undefined)
      await this.req('PUT', this.g(name, gid, '/settings/security/messages-admin-only'), { adminsOnly: s.announce });
    if (s.locked !== undefined)
      await this.req('PUT', this.g(name, gid, '/settings/security/info-admin-only'), { adminsOnly: s.locked });
    if (s.approvalMode !== undefined)
      await this.req('PUT', this.g(name, gid, '/settings/security/membership-approval'), {
        newMembersApprovalRequired: s.approvalMode,
      });
  }
  async getInviteCode(name: string, gid: string) {
    return String(await this.req('GET', this.g(name, gid, '/invite-code')));
  }
  async revokeInviteCode(name: string, gid: string) {
    return String(await this.req('POST', this.g(name, gid, '/invite-code/revoke')));
  }
  async joinGroup(name: string, code: string) {
    const r = await this.req<unknown>('POST', `/api/${enc(name)}/groups/join`, { code });
    return { gid: idOf(r) ?? '' };
  }
  async leaveGroup(name: string, gid: string) {
    await this.req('POST', this.g(name, gid, '/leave'));
  }
  private async participantsOp(name: string, gid: string, path: string, jids: string[]) {
    const r = await this.req<unknown>('POST', this.g(name, gid, path), { participants: jids.map((id) => ({ id })) });
    return perJid(jids, r);
  }
  addParticipants(name: string, gid: string, jids: string[]) {
    return this.participantsOp(name, gid, '/participants/add', jids);
  }
  removeParticipants(name: string, gid: string, jids: string[]) {
    return this.participantsOp(name, gid, '/participants/remove', jids);
  }
  promote(name: string, gid: string, jids: string[]) {
    return this.participantsOp(name, gid, '/admin/promote', jids);
  }
  demote(name: string, gid: string, jids: string[]) {
    return this.participantsOp(name, gid, '/admin/demote', jids);
  }
  async listJoinRequests(name: string, gid: string): Promise<JoinRequest[]> {
    const r = await this.req<Obj[]>('GET', this.g(name, gid, '/participants/join-requests'));
    return (r ?? []).map((x) => {
      const id = idOf(x.requesterPn) ?? idOf(x.requesterId) ?? idOf(x.JID) ?? idOf(x.id) ?? '';
      const lidRaw = idOf(x.requesterId);
      return {
        jid: id,
        lid: lidRaw?.endsWith('@lid') ? lidRaw : undefined,
        requestedAt: typeof x.timestamp === 'number' ? x.timestamp * 1000 : undefined,
        method: (x.requestMethod as string | null | undefined) ?? null,
      };
    });
  }
  approveJoinRequests(name: string, gid: string, jids: string[]) {
    return this.participantsOp(name, gid, '/participants/join-requests/approve', jids);
  }
  rejectJoinRequests(name: string, gid: string, jids: string[]) {
    return this.participantsOp(name, gid, '/participants/join-requests/reject', jids);
  }

  // ── mensagens ───────────────────────────────────────────
  async send(name: string, chatId: string, block: MessageBlock, opts: SendOptions = {}) {
    const base: Obj = { session: name, chatId };
    if (opts.mentions?.length) base.mentions = opts.mentions;
    if (opts.quoted) base.reply_to = opts.quoted;
    const mediaT = this.opts.mediaTimeoutMs ?? DEFAULT_WAHA_MEDIA_TIMEOUT_MS;
    let r: unknown;
    switch (block.type) {
      case 'text':
        r = await this.req('POST', '/api/sendText', { ...base, text: block.text, linkPreview: opts.linkPreview ?? true });
        break;
      case 'image':
        r = await this.req('POST', '/api/sendImage', {
          ...base,
          file: fileOf(block),
          caption: block.caption,
        }, mediaT);
        break;
      case 'video':
        r = await this.req('POST', '/api/sendVideo', {
          ...base,
          file: fileOf(block),
          caption: block.caption,
          convert: true,
          ...(block.asNote ? { asNote: true } : {}),
        }, mediaT);
        break;
      case 'sticker':
        // WAHA não tem envio de figurinha (nem no GOWS): quem chama checa `capabilities().sticker` antes
        throw new WaNotSupportedError('figurinha via WAHA');
      case 'file':
        r = await this.req('POST', '/api/sendFile', {
          ...base,
          file: fileOf(block, block.filename),
          caption: block.caption,
        }, mediaT);
        break;
      case 'voice':
        r = await this.req('POST', '/api/sendVoice', {
          ...base,
          file: fileOf(block),
          convert: true,
        }, mediaT);
        break;
      case 'poll':
        r = await this.req('POST', '/api/sendPoll', {
          ...base,
          poll: { name: block.name, options: block.options, multipleAnswers: block.multipleAnswers ?? false },
        });
        break;
      case 'contact':
        r = await this.req('POST', '/api/sendContactVcard', {
          ...base,
          contacts: [
            {
              fullName: block.name,
              organization: block.organization ?? '',
              phoneNumber: block.phone,
              whatsappId: block.phone.replace(/\D/g, ''),
            },
          ],
        });
        break;
      case 'event':
        r = await this.req('POST', `/api/${enc(name)}/events`, {
          chatId,
          event: {
            name: block.name,
            description: block.description,
            startTime: block.startTime,
            endTime: block.endTime,
            location: block.location ? { name: block.location } : undefined,
          },
        });
        break;
    }
    return { id: idOf(r) ?? '' };
  }
  /** `sec = 0` desafixa (`…/unpin`) */
  async pinMessage(name: string, chatId: string, id: string, sec: number) {
    const base = `/api/${enc(name)}/chats/${enc(chatId)}/messages/${enc(id)}`;
    if (sec === 0) await this.req('POST', `${base}/unpin`);
    else await this.req('POST', `${base}/pin`, { duration: sec });
  }
  /** `PUT /api/{s}/chats/{chat}/messages/{id}` corpo `{text}` */
  async editMessage(name: string, chatId: string, id: string, text: string) {
    await this.req('PUT', `/api/${enc(name)}/chats/${enc(chatId)}/messages/${enc(id)}`, { text });
  }
  async deleteMessage(name: string, chatId: string, id: string) {
    await this.req('DELETE', `/api/${enc(name)}/chats/${enc(chatId)}/messages/${enc(id)}`);
  }
  /**
   * `GET /api/{s}/chats/{chat}/messages?limit=N&downloadMedia=false` (mais recentes primeiro). Autor em grupo
   * = `participant` (GOWS pode mandar LID; o telefone vem em `_data.Info.SenderAlt`/`Sender`). Ainda não validado
   * contra um GOWS real (varredura em grupo de verdade): erro do servidor (p.ex. 501) sobe p/ quem chama decidir.
   */
  async listMessages(name: string, chatId: string, opts: { limit?: number } = {}): Promise<ChatMessage[]> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
    const r = await this.req<unknown>(
      'GET',
      `/api/${enc(name)}/chats/${enc(chatId)}/messages?limit=${limit}&downloadMedia=false`,
    );
    return (Array.isArray(r) ? r : []).map(chatMessageOf).filter((m): m is ChatMessage => !!m);
  }
  /** `GET /api/contacts/profile-picture` → `{ profilePictureURL }`; sem o campo = null */
  async getProfilePicture(name: string, jid: string): Promise<string | null> {
    const r = await this.req<{ profilePictureURL?: string | null }>(
      'GET',
      `/api/contacts/profile-picture?contactId=${enc(jid)}&session=${enc(name)}&refresh=false`,
    );
    return r?.profilePictureURL || null;
  }
  /** `GET /api/contacts` → `{ pushname, name }`; 404 (contato desconhecido) = null, outros erros sobem */
  async getContactName(name: string, jid: string): Promise<string | null> {
    try {
      const r = await this.req<{ pushname?: string | null; name?: string | null }>(
        'GET',
        `/api/contacts?contactId=${enc(jid)}&session=${enc(name)}`,
      );
      return r?.pushname || r?.name || null;
    } catch (e) {
      if (e instanceof WahaHttpError && e.status === 404) return null;
      throw e;
    }
  }
  async checkNumber(name: string, phone: string) {
    // GOWS (validado em chip real): `{ numberExists, chatId: "184…@lid", pn: "551199990002@c.us" }` — chatId é o
    // LID e `pn` a variante REAL do número (s/ 9 em conta antiga), p/ qualquer variante consultada
    const r = await this.req<{ numberExists: boolean; chatId?: string; pn?: string; lid?: string }>(
      'GET',
      `/api/contacts/check-exists?phone=${enc(phone)}&session=${enc(name)}`,
    );
    const isLid = (x?: string) => typeof x === 'string' && x.endsWith('@lid');
    const lid = isLid(r.lid) ? r.lid : isLid(r.chatId) ? r.chatId : undefined;
    const jid = typeof r.pn === 'string' && r.pn ? r.pn : isLid(r.chatId) ? undefined : r.chatId;
    return { exists: Boolean(r.numberExists), ...(jid ? { jid } : {}), ...(lid ? { lid } : {}) };
  }
  /** telefone de um LID (`GET /api/{s}/lids/{lid}` → `{ lid, pn }`); null se o WAHA não souber. */
  async phoneOfLid(name: string, lid: string): Promise<string | null> {
    const r = await this.req<{ lid?: string; pn?: string | null }>('GET', `/api/${enc(name)}/lids/${enc(lid)}`);
    return typeof r?.pn === 'string' && r.pn ? r.pn : null;
  }

  capabilities(): EngineCapabilities {
    return GOWS_CAPABILITIES;
  }
}
