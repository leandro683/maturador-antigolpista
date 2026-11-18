/** Contrato do engine WhatsApp. Implementações: waha/ (GOWS) e fake/. */

export type SessionStatus = 'STOPPED' | 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'FAILED';

/**
 * Mídia vai por `url` (o WAHA baixa) ou, se `data` (base64) vier preenchido, pelo próprio conteúdo — fallback do
 * envio quando a URL assinada falha. Com `data`, `url` fica só como referência.
 */
export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; data?: string; caption?: string; mimetype?: string }
  /** `gif`: MP4 que deveria tocar em loop sem som (GOWS não tem gifPlayback → sai como vídeo comum) */
  /** `asNote`: vídeo instantâneo (bolinha, PTV) — só com `capabilities().videoNote` */
  | { type: 'video'; url: string; data?: string; caption?: string; mimetype?: string; gif?: boolean; asNote?: boolean }
  /** figurinha (webp ≤ 1 MB), só com `capabilities().sticker` */
  | { type: 'sticker'; url: string; data?: string; mimetype?: string }
  | { type: 'file'; url: string; data?: string; filename?: string; caption?: string; mimetype?: string }
  | { type: 'voice'; url: string; data?: string; mimetype?: string }
  | { type: 'poll'; name: string; options: string[]; multipleAnswers?: boolean }
  /** cartão de contato (vCard); `phone` em E.164 */
  | { type: 'contact'; name: string; phone: string; organization?: string }
  | {
      type: 'event';
      name: string;
      description?: string;
      startTime: number; // unix seconds
      endTime?: number;
      location?: string;
    };

export type SendOptions = {
  /** JIDs mencionados; `['all']` = menção a todos (quando o engine suporta). */
  mentions?: string[];
  ephemeralSec?: number;
  quoted?: string;
  linkPreview?: boolean;
};

export type GroupParticipant = { jid: string; lid?: string; isAdmin: boolean; isSuperAdmin: boolean };

export type GroupInfo = {
  gid: string;
  subject: string;
  description?: string;
  inviteCode?: string;
  announce?: boolean;
  locked?: boolean;
  approvalMode?: boolean;
  participants: GroupParticipant[];
};
export type WaGroup = GroupInfo;

export type GroupSettings = { announce?: boolean; locked?: boolean; approvalMode?: boolean; ephemeralSec?: number };

export type PerJidResult = { jid: string; ok: boolean; error?: string };

export type JoinRequest = { jid: string; lid?: string; requestedAt?: number; method?: string | null };

export type EngineSession = { name: string; status: SessionStatus | string; phone?: string | null; pushName?: string };

/**
 * Mensagem recente de um chat ("Analisar grupos"). `from` = autor (o participante, em grupo); `fromAlt` = outra
 * forma do mesmo autor quando o servidor manda as duas (telefone e LID). `ts` em ms.
 */
export type ChatMessage = {
  id: string;
  from: string;
  fromAlt?: string;
  fromMe: boolean;
  body?: string;
  hasMedia: boolean;
  ts: number;
};

export type EngineCapabilities = {
  communities: boolean;
  polls: boolean;
  events: boolean;
  joinRequests: boolean;
  /** mensagem temporária por envio; ausente = não */
  ephemeral?: boolean;
  /** GIF animado (vídeo com gifPlayback); ausente = não (sai como vídeo) */
  gif?: boolean;
  /** cartão de contato (vCard); ausente = sim */
  vcard?: boolean;
  /** editar mensagem já enviada; ausente = não */
  editMessage?: boolean;
  /** figurinha e vídeo instantâneo (PTV); ausente = não */
  sticker?: boolean;
  videoNote?: boolean;
  /** botões, lista e Pix; ausente = não */
  buttons?: boolean;
  list?: boolean;
  pix?: boolean;
};

export interface WaEngine {
  createSession(name: string): Promise<void>;
  startSession(name: string): Promise<void>;
  stopSession(name: string): Promise<void>;
  logoutSession(name: string): Promise<void>;
  deleteSession(name: string): Promise<void>;
  /** sessões existentes no servidor (importar sem QR); opcional p/ engines sem listagem */
  listSessions?(): Promise<EngineSession[]>;
  /** ciclo de 5 QRs imposto no app */
  getQr(name: string): Promise<{ image: string; attempt: number }>;
  getStatus(name: string): Promise<SessionStatus>;
  getMe(name: string): Promise<{ jid: string; lid?: string; pushName: string; platform?: string }>;
  createGroup(name: string, input: { subject: string; participants: string[] }): Promise<{ gid: string; inviteCode: string }>;
  getGroup(name: string, gid: string): Promise<GroupInfo>;
  /** grupos da sessão (GET /api/{session}/groups); opcional p/ engines sem listagem */
  listGroups?(session: string): Promise<WaGroup[]>;
  setSubject(name: string, gid: string, subject: string): Promise<void>;
  setDescription(name: string, gid: string, description: string): Promise<void>;
  setPicture(name: string, gid: string, url: string): Promise<void>;
  setSettings(name: string, gid: string, settings: GroupSettings): Promise<void>;
  getInviteCode(name: string, gid: string): Promise<string>;
  revokeInviteCode(name: string, gid: string): Promise<string>;
  joinGroup(name: string, code: string): Promise<{ gid: string }>;
  leaveGroup(name: string, gid: string): Promise<void>;
  addParticipants(name: string, gid: string, jids: string[]): Promise<PerJidResult[]>;
  removeParticipants(name: string, gid: string, jids: string[]): Promise<PerJidResult[]>;
  promote(name: string, gid: string, jids: string[]): Promise<PerJidResult[]>;
  demote(name: string, gid: string, jids: string[]): Promise<PerJidResult[]>;
  listJoinRequests(name: string, gid: string): Promise<JoinRequest[]>;
  approveJoinRequests(name: string, gid: string, jids: string[]): Promise<PerJidResult[]>;
  rejectJoinRequests(name: string, gid: string, jids: string[]): Promise<PerJidResult[]>;
  send(name: string, chatId: string, block: MessageBlock, opts?: SendOptions): Promise<{ id: string }>;
  pinMessage(name: string, chatId: string, id: string, sec: number): Promise<void>;
  deleteMessage(name: string, chatId: string, id: string): Promise<void>;
  /** troca o texto de uma mensagem já enviada (só se `capabilities().editMessage`) */
  editMessage(name: string, chatId: string, id: string, text: string): Promise<void>;
  /** últimas mensagens de um chat (mais recentes primeiro); opcional — engine sem histórico não implementa */
  listMessages?(name: string, chatId: string, opts?: { limit?: number }): Promise<ChatMessage[]>;
  /** anti-impostor: URL da foto de perfil do contato; null = sem foto/privada. Opcional */
  getProfilePicture?(name: string, jid: string): Promise<string | null>;
  /** anti-impostor: nome do contato (pushname, senão name); null = desconhecido. Opcional */
  getContactName?(name: string, jid: string): Promise<string | null>;
  checkNumber(name: string, phone: string): Promise<{ exists: boolean; jid?: string; lid?: string }>;
  /** telefone (JID `@c.us`) de um LID, quando o servidor souber; opcional */
  phoneOfLid?(name: string, lid: string): Promise<string | null>;
  capabilities(): EngineCapabilities;
}

export type EventParticipant = { jid: string; lid?: string };

/** Evento normalizado (engine-agnóstico). `ts` em ms. */
export type WaEvent =
  | { kind: 'session.status'; session: string; status: SessionStatus | string; reason?: string; ts: number }
  | {
      kind: 'group.participants';
      session: string;
      gid: string;
      action: 'add' | 'remove' | 'promote' | 'demote';
      participants: EventParticipant[];
      actor?: string;
      ts: number;
    }
  | {
      kind: 'group.join-request';
      session: string;
      gid: string;
      participant: EventParticipant;
      action: 'created' | 'rejected' | 'revoked';
      method?: string | null;
      ts: number;
    }
  | {
      kind: 'group.update';
      session: string;
      gid: string;
      subject?: string;
      description?: string;
      announce?: boolean;
      inviteCode?: string;
      ts: number;
    }
  /** a própria conta entrou/saiu de um grupo (group.v2.join/leave) */
  | { kind: 'group.self'; session: string; gid: string; action: 'join' | 'leave'; subject?: string; ts: number }
  | {
      kind: 'message.in';
      session: string;
      id: string;
      chatId: string;
      from: string;
      fromMe: boolean;
      body?: string;
      hasMedia: boolean;
      ts: number;
    }
  | {
      kind: 'message.ack';
      session: string;
      id: string;
      chatId: string;
      /** quem confirmou (só em ack de grupo, `message.ack.group`) */
      participant?: string;
      ack: number;
      ackName?: string;
      ts: number;
    }
  | {
      kind: 'message.reaction';
      session: string;
      id: string;
      chatId: string;
      from: string;
      messageId: string;
      emoji: string;
      ts: number;
    }
  | {
      kind: 'poll.vote';
      session: string;
      pollId: string;
      chatId: string;
      voter: string;
      selectedOptions: string[];
      ts: number;
    };

export type WaEventKind = WaEvent['kind'];
