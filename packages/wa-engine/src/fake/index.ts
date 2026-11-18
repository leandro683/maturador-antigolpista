import type {
  ChatMessage,
  EngineCapabilities,
  GroupInfo,
  GroupParticipant,
  GroupSettings,
  JoinRequest,
  MessageBlock,
  PerJidResult,
  SendOptions,
  SessionStatus,
  WaEngine,
  WaEvent,
} from '../types';
import { QrCycle } from '../waha/sessions';

type FakeGroup = GroupInfo & { session: string; pending: JoinRequest[] };
export type SentMessage = { session: string; chatId: string; block: MessageBlock; opts: SendOptions; id: string };
type Listener = (e: WaEvent) => void | Promise<void>;

/**
 * Engine em memória p/ testes: cria grupos, guarda envios e emite WaEvents
 * como o WAHA emitiria (via `onEvent`). Determinístico (contadores, sem random).
 */
/** PNG válido (150x150, padrão parecido com QR) só para o painel mostrar uma imagem no modo demo; não é lido por nenhum aplicativo. */
const FAKE_QR_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAJYAAACWCAAAAAAZai4+AAAA/klEQVR4nO3WQQ6DMAwAwfz/0/QKQkR2Ca2FZ48WwXOKMka4bdedyeKwsF7E2qatwmV3YWH1ZI1T8d9Fiu/CwsKKsO5PsLCwvmOtomBhYc1ZV0W+iRTfhYXVkxVpviA+WRwW1itY99c8MimBwML6NataWJmwMlVllbsa9mFhtWHVoRwmJRBYWF6nJcPKhJVplLsa9mFhtWHVoRwmJRBYWF6nJcPKhJVplLsa9mFhtWHVoRwmJRBYWF6nJcPKhJVpxDsfe26ChdWTtU37Gw4LqyVrnLo69nRYWFgR1tMTLCys+fynOCyslqyrIt+sDSsTVqbarEhz6OKrAQurF+sDiwbYVwcDP8gAAAAASUVORK5CYII=';

export class FakeEngine implements WaEngine {
  readonly sessions = new Map<string, { status: SessionStatus; me: { jid: string; pushName: string } }>();
  readonly groups = new Map<string, FakeGroup>();
  readonly sent: SentMessage[] = [];
  /** histórico por chat p/ `listMessages` (testes semeiam; mais recentes primeiro) */
  readonly history = new Map<string, ChatMessage[]>();
  /** jid -> URL da foto / nome de contato p/ `getProfilePicture`/`getContactName` (testes semeiam) */
  readonly pictures = new Map<string, string>();
  readonly names = new Map<string, string>();
  readonly qrCycle = new QrCycle();
  private listeners: Listener[] = [];
  private seq = 0;
  private clock: () => number;

  constructor(
    private caps: EngineCapabilities = { communities: false, polls: true, events: true, joinRequests: true },
    opts: { now?: () => number } = {},
  ) {
    this.clock = opts.now ?? (() => Date.now());
  }

  onEvent(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  async emit(e: WaEvent): Promise<void> {
    for (const l of this.listeners) await l(e);
  }

  private next(prefix: string) {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  private session(name: string) {
    const s = this.sessions.get(name);
    if (!s) throw new Error(`sessão inexistente: ${name}`);
    return s;
  }

  private group(gid: string) {
    const g = this.groups.get(gid);
    if (!g) throw new Error(`grupo inexistente: ${gid}`);
    return g;
  }

  private async setStatus(name: string, status: SessionStatus) {
    this.session(name).status = status;
    await this.emit({ kind: 'session.status', session: name, status, ts: this.clock() });
  }

  // sessões
  async createSession(name: string) {
    this.sessions.set(name, { status: 'STOPPED', me: { jid: `5500000${this.sessions.size}@c.us`, pushName: name } });
  }
  async listSessions() {
    return [...this.sessions].map(([name, x]) => ({
      name,
      status: x.status,
      phone: x.me.jid.endsWith('@c.us') ? `+${x.me.jid.split('@')[0]}` : null,
      pushName: x.me.pushName,
    }));
  }
  async startSession(name: string) {
    await this.setStatus(name, 'SCAN_QR_CODE');
  }
  async stopSession(name: string) {
    await this.setStatus(name, 'STOPPED');
  }
  async logoutSession(name: string) {
    await this.setStatus(name, 'STOPPED');
  }
  async deleteSession(name: string) {
    this.sessions.delete(name);
  }
  async getQr(name: string) {
    this.session(name);
    return { image: `data:image/png;base64,${FAKE_QR_PNG}`, attempt: this.qrCycle.next(name) };
  }
  /** Simula o celular lendo o QR. */
  async pair(name: string) {
    this.qrCycle.reset(name);
    await this.setStatus(name, 'WORKING');
  }
  async getStatus(name: string) {
    return this.session(name).status;
  }
  async getMe(name: string) {
    return { ...this.session(name).me };
  }

  // grupos
  async createGroup(name: string, input: { subject: string; participants: string[] }) {
    const me = this.session(name).me.jid;
    const gid = `${this.next('1203630')}@g.us`;
    const participants: GroupParticipant[] = [
      { jid: me, isAdmin: true, isSuperAdmin: true },
      ...input.participants.map((jid) => ({ jid, isAdmin: false, isSuperAdmin: false })),
    ];
    const inviteCode = this.next('INV');
    this.groups.set(gid, { session: name, gid, subject: input.subject, inviteCode, participants, pending: [] });
    return { gid, inviteCode };
  }
  async getGroup(_name: string, gid: string) {
    const { session: _s, pending: _p, ...info } = this.group(gid);
    return { ...info, participants: info.participants.map((p) => ({ ...p })) };
  }
  async listGroups(name: string) {
    const me = this.sessions.get(name)?.me.jid; // também os grupos em que a sessão entrou, como o WAHA
    const mine = [...this.groups.values()].filter((g) => g.session === name || g.participants.some((p) => p.jid === me));
    return Promise.all(mine.map((g) => this.getGroup(name, g.gid)));
  }
  async setSubject(name: string, gid: string, subject: string) {
    this.group(gid).subject = subject;
    await this.emit({ kind: 'group.update', session: name, gid, subject, ts: this.clock() });
  }
  async setDescription(name: string, gid: string, description: string) {
    this.group(gid).description = description;
    await this.emit({ kind: 'group.update', session: name, gid, description, ts: this.clock() });
  }
  async setPicture(_name: string, gid: string, _url: string) {
    this.group(gid);
  }
  async setSettings(_name: string, gid: string, s: GroupSettings) {
    const g = this.group(gid);
    if (s.announce !== undefined) g.announce = s.announce;
    if (s.locked !== undefined) g.locked = s.locked;
    if (s.approvalMode !== undefined) g.approvalMode = s.approvalMode;
  }
  async getInviteCode(_name: string, gid: string) {
    return this.group(gid).inviteCode ?? '';
  }
  async revokeInviteCode(name: string, gid: string) {
    const g = this.group(gid);
    g.inviteCode = this.next('INV');
    await this.emit({ kind: 'group.update', session: name, gid, inviteCode: g.inviteCode, ts: this.clock() });
    return g.inviteCode;
  }
  async joinGroup(name: string, code: string) {
    const g = [...this.groups.values()].find((x) => x.inviteCode === code);
    if (!g) throw new Error('convite inválido');
    await this.simulateJoin(g.gid, this.session(name).me.jid, name);
    return { gid: g.gid };
  }
  async leaveGroup(name: string, gid: string) {
    await this.removeParticipants(name, gid, [this.session(name).me.jid]);
  }
  async addParticipants(name: string, gid: string, jids: string[]): Promise<PerJidResult[]> {
    const g = this.group(gid);
    for (const jid of jids)
      if (!g.participants.some((p) => p.jid === jid)) g.participants.push({ jid, isAdmin: false, isSuperAdmin: false });
    await this.emit({
      kind: 'group.participants',
      session: name,
      gid,
      action: 'add',
      participants: jids.map((jid) => ({ jid })),
      ts: this.clock(),
    });
    return jids.map((jid) => ({ jid, ok: true }));
  }
  async removeParticipants(name: string, gid: string, jids: string[]): Promise<PerJidResult[]> {
    const g = this.group(gid);
    g.participants = g.participants.filter((p) => !jids.includes(p.jid));
    await this.emit({
      kind: 'group.participants',
      session: name,
      gid,
      action: 'remove',
      participants: jids.map((jid) => ({ jid })),
      ts: this.clock(),
    });
    return jids.map((jid) => ({ jid, ok: true }));
  }
  private async setAdmin(name: string, gid: string, jids: string[], isAdmin: boolean) {
    const g = this.group(gid);
    const res = jids.map((jid) => {
      const p = g.participants.find((x) => x.jid === jid);
      if (!p) return { jid, ok: false, error: 'not-participant' };
      p.isAdmin = isAdmin;
      return { jid, ok: true };
    });
    await this.emit({
      kind: 'group.participants',
      session: name,
      gid,
      action: isAdmin ? 'promote' : 'demote',
      participants: res.filter((r) => r.ok).map((r) => ({ jid: r.jid })),
      ts: this.clock(),
    });
    return res;
  }
  promote(name: string, gid: string, jids: string[]) {
    return this.setAdmin(name, gid, jids, true);
  }
  demote(name: string, gid: string, jids: string[]) {
    return this.setAdmin(name, gid, jids, false);
  }
  async listJoinRequests(_name: string, gid: string) {
    return [...this.group(gid).pending];
  }
  async approveJoinRequests(name: string, gid: string, jids: string[]) {
    const g = this.group(gid);
    const ok = jids.filter((j) => g.pending.some((p) => p.jid === j));
    g.pending = g.pending.filter((p) => !ok.includes(p.jid));
    if (ok.length) await this.addParticipants(name, gid, ok);
    return jids.map((jid) => (ok.includes(jid) ? { jid, ok: true } : { jid, ok: false, error: 'no-request' }));
  }
  async rejectJoinRequests(name: string, gid: string, jids: string[]) {
    const g = this.group(gid);
    const res = jids.map((jid) => {
      const had = g.pending.some((p) => p.jid === jid);
      return had ? { jid, ok: true } : { jid, ok: false, error: 'no-request' };
    });
    g.pending = g.pending.filter((p) => !jids.includes(p.jid));
    for (const r of res.filter((x) => x.ok))
      await this.emit({
        kind: 'group.join-request',
        session: name,
        gid,
        participant: { jid: r.jid },
        action: 'rejected',
        ts: this.clock(),
      });
    return res;
  }

  /** Simula alguém entrando pelo link (ou pedido, se approvalMode). */
  async simulateJoin(gid: string, jid: string, session = this.group(gid).session) {
    const g = this.group(gid);
    if (g.approvalMode) {
      g.pending.push({ jid, requestedAt: this.clock(), method: 'invite_link' });
      await this.emit({
        kind: 'group.join-request',
        session,
        gid,
        participant: { jid },
        action: 'created',
        method: 'invite_link',
        ts: this.clock(),
      });
      return;
    }
    await this.addParticipants(session, gid, [jid]);
  }

  // mensagens
  async send(name: string, chatId: string, block: MessageBlock, opts: SendOptions = {}) {
    this.session(name);
    if (block.type === 'poll' && !this.caps.polls) throw new Error('polls não suportado');
    if (block.type === 'event' && !this.caps.events) throw new Error('events não suportado');
    if (block.type === 'sticker' && !this.caps.sticker) throw new Error('sticker não suportado');
    const id = this.next('MSG');
    this.sent.push({ session: name, chatId, block, opts, id });
    return { id };
  }
  async pinMessage() {}
  async deleteMessage(_name: string, _chatId: string, id: string) {
    const i = this.sent.findIndex((m) => m.id === id);
    if (i >= 0) this.sent.splice(i, 1);
  }
  async editMessage(_name: string, _chatId: string, id: string, text: string) {
    if (!this.caps.editMessage) throw new Error('editMessage não suportado');
    const m = this.sent.find((x) => x.id === id);
    if (m && m.block.type === 'text') m.block = { type: 'text', text };
  }
  async getProfilePicture(name: string, jid: string) {
    this.session(name);
    return this.pictures.get(jid) ?? null;
  }
  async getContactName(name: string, jid: string) {
    this.session(name);
    return this.names.get(jid) ?? null;
  }
  async listMessages(name: string, chatId: string, opts: { limit?: number } = {}) {
    this.session(name);
    return (this.history.get(chatId) ?? []).slice(0, opts.limit ?? 50);
  }
  async checkNumber(_name: string, phone: string) {
    const digits = phone.replace(/\D/g, '');
    return digits.length >= 10 ? { exists: true, jid: `${digits}@c.us` } : { exists: false };
  }
  capabilities() {
    return { ...this.caps };
  }
}
