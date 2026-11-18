import { z } from 'zod';

/**
 * Config do anti-hacker por campanha, gravada em `campaigns.anti_hacker` (jsonb). Mantém as chaves
 * mais simples (`enabled`, `reactionProtection`) e acrescenta as do anti-golpista — leitura tolerante (jsonb antigo /
 * null → defaults).
 */

/** Padrões "suspeitos" default (links, pix, convite de grupo). Regex sem flags; aplicadas com `i`. */
export const DEFAULT_SUSPICIOUS_PATTERNS = [
  'https?://\\S+',
  '\\bwww\\.\\S+',
  'chat\\.whatsapp\\.com/\\S+',
  '\\bpix\\b',
  'chave\\s+pix',
  '\\bconvite\\b',
] as const;

/** Nomes de perfil usados por golpistas ("Suporte", "Adm"…). Regex sem flags; aplicadas com `i`. `adi?ministra` pega também "adiministra". */
export const DEFAULT_IMPERSONATION_NAMES = [
  '\\bsuporte\\b',
  '\\badm\\b',
  '\\badmin\\b',
  '\\badi?ministra',
  '\\batendimento\\b',
  'suporte\\s+oficial',
  'atendimento\\s+oficial',
] as const;

export const ALERT_CHANNELS = ['painel'] as const;

const regexSource = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => {
    try {
      new RegExp(s, 'i');
      return true;
    } catch {
      return false;
    }
  }, 'regex inválida');

export const antiHackerSchema = z.object({
  enabled: z.boolean().default(false),
  /** proteção por reações: padrão DESLIGADO — só age se a campanha ligar (payload real do GOWS não validado) */
  reactionProtection: z.boolean().default(false),
  /** apaga a mensagem do não-admin (conta admin da campanha) */
  deleteNonAdminMessages: z.boolean().default(true),
  /** remove o autor / o promovido fora da allowlist */
  removeAuthor: z.boolean().default(true),
  /** além da lista anti-hacker da campanha, manda p/ o anti-spam compartilhado (só vale nas campanhas com opt-in) */
  sendToAntiSpam: z.boolean().default(true),
  /** promoção de número fora da allowlist → rebaixa; conta da campanha rebaixada/removida → alerta + re-promove */
  protectAdmins: z.boolean().default(true),
  /** números extra permitidos como admin (além de "Números administrativos", contas da campanha e colaboradores) */
  allowedAdminNumbers: z.array(z.string().trim().min(1).max(40)).max(200).default([]),
  /** nome/descrição trocados por não-autorizado → volta aos valores do grupo no painel */
  revertNameDescriptionChange: z.boolean().default(true),
  /** com o grupo aberto, só age quando a mensagem casa um padrão suspeito */
  flagSuspiciousContent: z.boolean().default(true),
  suspiciousPatterns: z.array(regexSource).max(30).default([...DEFAULT_SUSPICIOUS_PATTERNS]),
  /** impostor (foto de referência / nome de "Suporte"): off não consulta perfil; review só abre incidente; auto remove pela foto */
  impersonation: z.enum(['off', 'review', 'auto']).default('off'),
  /** dHash (16 hex) das artes oficiais que golpistas usam de foto */
  impersonationPhotos: z
    .array(z.object({ label: z.string().trim().min(1).max(60), hash: z.string().regex(/^[0-9a-f]{16}$/) }))
    .max(20)
    .default([]),
  impersonationNames: z.array(regexSource).max(30).default([...DEFAULT_IMPERSONATION_NAMES]),
  /** no modo `auto`, nome suspeito sozinho também remove e bloqueia (risco: pessoa real chamada "Atendimento") */
  impersonationRemoveByName: z.boolean().default(false),
  /** análise automática: 1x por dia (3h07) confere quem entrou nas últimas 48 h */
  impersonationAutoScan: z.boolean().default(false),
  /**
   * contas (id) de FORA da campanha que também consultam foto/nome no rodízio, sem virar espiã (o papel de espiã vale
   * para a conta inteira e tiraria o chip das outras campanhas dele). shortcut: sem campo no painel, só pelo banco
   */
  impersonationLookupAccountIds: z.array(z.string().uuid()).max(10).default([]),
  /** participante bloqueado que entrar é removido */
  removeBlockedOnJoin: z.boolean().default(true),
  alertChannels: z.array(z.enum(ALERT_CHANNELS)).default(['painel']),
  /** registra o que faria, sem agir (auditoria / validação antes de valer) */
  dryRun: z.boolean().default(false),
});

export type AntiHackerConfig = z.output<typeof antiHackerSchema>;
export type AntiHackerInput = z.input<typeof antiHackerSchema>;

export const DEFAULT_ANTI_HACKER: AntiHackerConfig = antiHackerSchema.parse({});

/** jsonb da campanha → config completa. Campos inválidos caem no default (nunca derruba o handler). */
export function readAntiHacker(raw: unknown): AntiHackerConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ANTI_HACKER };
  const r = antiHackerSchema.safeParse(raw);
  if (r.success) return r.data;
  const out: Record<string, unknown> = { ...DEFAULT_ANTI_HACKER };
  const shape = antiHackerSchema.shape;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const field = shape[k as keyof typeof shape];
    if (!field) continue;
    const p = field.safeParse(v);
    if (p.success) out[k] = p.data;
  }
  return out as AntiHackerConfig;
}

export function compilePatterns(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, 'i'));
    } catch {
      /* ignorado: já validado no save */
    }
  }
  return out;
}

/** pré-requisitos p/ ligar o anti-hacker. */
export type Readiness = {
  spyActive: boolean;
  spyAccounts: number;
  adminNumbers: number;
  campaignAccounts: number;
  ok: boolean;
  missing: string[];
};

export function readiness(i: {
  accounts: { rolePolicy: { role?: string } | null; status: string }[];
  adminNumbers: number;
}): Readiness {
  const spies = i.accounts.filter((a) => a.rolePolicy?.role === 'spy');
  const spyActive = spies.some((a) => a.status === 'active' || a.status === 'connected');
  const missing: string[] = [];
  if (!spies.length) missing.push('ative uma conta espiã nesta campanha');
  else if (!spyActive) missing.push('a conta espiã não está conectada');
  if (i.adminNumbers === 0) missing.push('cadastre os números administrativos');
  return {
    spyActive,
    spyAccounts: spies.length,
    adminNumbers: i.adminNumbers,
    campaignAccounts: i.accounts.length,
    ok: spies.length > 0 && i.adminNumbers > 0,
    missing,
  };
}

export const READINESS_MESSAGE = 'Ative uma conta espiã e cadastre os números administrativos';
