import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { brPhoneVariants } from '@mag/shared/phone';
import { exec } from './util';
import type { WarmupMode, WarmupSettings } from './settings';
import type { ScriptLine } from './rules';
import { rampFor } from './ramp';

/** Maturador de chips: repositório (SQL cru). Nunca apaga linhas: "remover" = active=false. */

/** Dia de Brasília `day` (YYYY-MM-DD) como intervalo semiaberto sobre `col` (usa índice, ao contrário de envolver a coluna). */
const inDay = (col: string, day: string) =>
  sql`${sql.raw(col)} >= (${day}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
    AND ${sql.raw(col)} < ((${day}::date + 1))::timestamp AT TIME ZONE 'America/Sao_Paulo'`;
const num = (v: unknown) => Number(v ?? 0);
const date = (v: unknown) => (v == null ? null : new Date(v as string | Date));
/** Só os dígitos do telefone de um JID (sem `@…` nem sufixo de dispositivo `:12`). */
const digitsOf = (s: string | null | undefined) => (s ? s.split('@')[0]!.split(':')[0]!.replace(/\D/g, '') : '');
/** Variantes (com/sem 9º dígito) de um telefone só-dígitos. */
const variants = (d: string) => new Set([d, ...brPhoneVariants(`+${d}`).map((v) => v.slice(1))]);

export async function getSettings(db: Db): Promise<WarmupSettings> {
  const [r] = await exec(db, sql`SELECT * FROM mag.warmup_settings WHERE id = 1`);
  if (!r) throw new Error('warmup_settings sem linha 1');
  return {
    enabled: Boolean(r.enabled),
    mode: r.mode as WarmupMode,
    model: String(r.model),
    theme: String(r.theme),
    allowed: String(r.allowed),
    forbidden: String(r.forbidden),
    gapMinSec: num(r.gap_min_sec),
    gapMaxSec: num(r.gap_max_sec),
    typingCps: num(r.typing_cps),
    pauseMinMin: num(r.pause_min_min),
    pauseMaxMin: num(r.pause_max_min),
    turnsMin: num(r.turns_min),
    turnsMax: num(r.turns_max),
    windowStart: r.window_start == null ? null : num(r.window_start),
    windowEnd: r.window_end == null ? null : num(r.window_end),
    dailyCapUsd: num(r.daily_cap_usd),
    freeModels: r.free_models as string[],
    paidModels: r.paid_models as string[],
    paidBackup: Boolean(r.paid_backup),
    activeCap: num(r.active_cap),
    pausedUntil: date(r.paused_until),
    pauseReason: r.pause_reason == null ? null : String(r.pause_reason),
  };
}

/** Não grava `enabled`: quem liga/desliga é `setEnabled` (evita um salvar concorrente religar após "Pausar tudo"). */
const pgArray = (l: string[]) => sql`ARRAY[${sql.join(l.map((x) => sql`${x}`), sql`, `)}]::text[]`;

export async function saveSettings(db: Db, s: Omit<WarmupSettings, 'pausedUntil' | 'pauseReason'>): Promise<void> {
  await exec(
    db,
    sql`UPDATE mag.warmup_settings SET mode = ${s.mode}, model = ${s.model}, theme = ${s.theme},
      allowed = ${s.allowed}, forbidden = ${s.forbidden}, gap_min_sec = ${s.gapMinSec}, gap_max_sec = ${s.gapMaxSec},
      typing_cps = ${s.typingCps}, pause_min_min = ${s.pauseMinMin}, pause_max_min = ${s.pauseMaxMin},
      turns_min = ${s.turnsMin}, turns_max = ${s.turnsMax}, window_start = ${s.windowStart}, window_end = ${s.windowEnd},
      daily_cap_usd = ${s.dailyCapUsd}, free_models = ${pgArray(s.freeModels)}, paid_models = ${pgArray(s.paidModels)},
      paid_backup = ${s.paidBackup}, active_cap = ${s.activeCap}, updated_at = now() WHERE id = 1`,
  );
}

export async function setEnabled(db: Db, on: boolean): Promise<void> {
  await exec(db, sql`UPDATE mag.warmup_settings SET enabled = ${on}, updated_at = now() WHERE id = 1`);
}

export const NO_JID_MSG = 'Esta conta ainda não tem número sincronizado. Reconecte a conta antes de usar no maturador.';

export async function addChip(db: Db, accountId: string): Promise<void> {
  const [a] = await exec(db, sql`SELECT jid FROM mag.wa_accounts WHERE id = ${accountId}`);
  if (!a?.jid) throw new Error(NO_JID_MSG);
  await exec(
    db,
    sql`INSERT INTO mag.warmup_chips (account_id) VALUES (${accountId})
      ON CONFLICT (account_id) DO UPDATE SET active = true, paused_reason = NULL`,
  );
}

/** Marca como canceladas as conversas ativas que casam com `where`. */
const cancelActive = (db: Parameters<typeof exec>[0], where: SQL) =>
  exec(
    db,
    sql`UPDATE mag.warmup_conversations SET status = 'canceled', ended_at = now()
      WHERE status = 'active' AND ${where}`,
  );

export async function setChipActive(db: Db, accountId: string, active: boolean, reason?: string): Promise<void> {
  await db.transaction(async (tx) => {
    await exec(
      tx,
      sql`UPDATE mag.warmup_chips SET active = ${active}, paused_reason = ${active ? null : (reason ?? null)},
        paused_at = ${active ? null : sql`now()`}
        WHERE account_id = ${accountId}`,
    );
    if (!active) {
      await cancelActive(
        tx,
        sql`pair_id IN (SELECT id FROM mag.warmup_pairs WHERE account_a = ${accountId} OR account_b = ${accountId})`,
      );
    }
  });
}

/** Chips pausados pelo sistema por queda (`reason`) há pelo menos até `pausedBefore`; pausa sem hora conta como vencida. */
export async function chipsPausedFor(db: Db, reason: string, pausedBefore: Date): Promise<string[]> {
  const rows = await exec(
    db,
    sql`SELECT account_id FROM mag.warmup_chips
      WHERE NOT active AND paused_reason = ${reason} AND (paused_at IS NULL OR paused_at <= ${pausedBefore.toISOString()}::timestamptz)`,
  );
  return rows.map((r) => String(r.account_id));
}

/** Cancela todas as conversas ativas (Pausar tudo). */
export async function cancelAllActive(db: Db): Promise<void> {
  await cancelActive(db, sql`true`);
}

export async function setPairNext(db: Db, pairId: string, nextAt: Date): Promise<void> {
  await exec(db, sql`UPDATE mag.warmup_pairs SET next_at = ${nextAt.toISOString()}::timestamptz WHERE id = ${pairId}`);
}

export async function addPair(db: Db, a: string, b: string): Promise<string> {
  if (a === b) throw new Error('um chip não pode formar par consigo mesmo');
  const [x, y] = a < b ? [a, b] : [b, a];
  const [c] = await exec(db, sql`SELECT count(*)::int AS n FROM mag.warmup_chips WHERE account_id IN (${x}, ${y})`);
  if (num(c?.n) !== 2) throw new Error('as duas contas precisam estar no maturador');
  const [r] = await exec(
    db,
    sql`INSERT INTO mag.warmup_pairs (account_a, account_b) VALUES (${x}, ${y})
      ON CONFLICT (account_a, account_b) DO UPDATE SET active = true RETURNING id`,
  );
  return String(r!.id);
}

export async function confirmPair(db: Db, id: string): Promise<void> {
  await exec(db, sql`UPDATE mag.warmup_pairs SET contacts_confirmed_at = now() WHERE id = ${id}`);
}

export async function setPairActive(db: Db, id: string, active: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    await exec(tx, sql`UPDATE mag.warmup_pairs SET active = ${active} WHERE id = ${id}`);
    if (!active) await cancelActive(tx, sql`pair_id = ${id}`);
  });
}

/** Reserva o par antes da chamada à IA (empurra `next_at` por `holdMs`): só um tick sobreposto passa. */
export async function claimPair(db: Db, pairId: string, now: Date, holdMs: number): Promise<boolean> {
  const rows = await exec(
    db,
    sql`UPDATE mag.warmup_pairs SET next_at = ${new Date(now.getTime() + holdMs).toISOString()}::timestamptz
      WHERE id = ${pairId} AND (next_at IS NULL OR next_at <= ${now.toISOString()}::timestamptz) RETURNING id`,
  );
  return rows.length > 0;
}

export type PairRow = { id: string; a: string; b: string; nextAt: Date | null };

export async function duePairs(db: Db, now: Date): Promise<PairRow[]> {
  const rows = await exec(
    db,
    sql`SELECT p.id, p.account_a, p.account_b, p.next_at FROM mag.warmup_pairs p
      JOIN mag.warmup_chips ca ON ca.account_id = p.account_a AND ca.active
      JOIN mag.warmup_chips cb ON cb.account_id = p.account_b AND cb.active
      WHERE p.active AND p.contacts_confirmed_at IS NOT NULL
        AND (p.next_at IS NULL OR p.next_at <= ${now.toISOString()}::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM mag.warmup_conversations c WHERE c.pair_id = p.id AND c.status = 'active')
      ORDER BY p.next_at NULLS FIRST, p.created_at`,
  );
  return rows.map((r) => ({ id: String(r.id), a: String(r.account_a), b: String(r.account_b), nextAt: date(r.next_at) }));
}

export type Conversation = {
  id: string;
  pairId: string;
  a: string;
  b: string;
  mode: WarmupMode;
  status: string;
  lines: ScriptLine[];
  turnsTarget: number;
  turnsDone: number;
  lastSpeaker: string | null;
  lastAt: Date;
  themeId: string | null;
};

function toConv(r: Record<string, unknown>): Conversation {
  return {
    id: String(r.id),
    pairId: String(r.pair_id),
    a: String(r.account_a),
    b: String(r.account_b),
    mode: r.mode as WarmupMode,
    status: String(r.status),
    lines: (r.lines as ScriptLine[]) ?? [],
    turnsTarget: num(r.turns_target),
    turnsDone: num(r.turns_done),
    lastSpeaker: (r.last_speaker as string | null) ?? null,
    lastAt: new Date(r.last_at as string),
    themeId: r.theme_id == null ? null : String(r.theme_id),
  };
}

const convWhere = async (db: Db, where: SQL) => {
  const [r] = await exec(
    db,
    sql`SELECT c.*, p.account_a, p.account_b FROM mag.warmup_conversations c
      JOIN mag.warmup_pairs p ON p.id = c.pair_id WHERE ${where}`,
  );
  return r ? toConv(r) : null;
};

export const getConversation = (db: Db, id: string) => convWhere(db, sql`c.id = ${id}`);

export const activeConversationOf = (db: Db, pairId: string) =>
  convWhere(db, sql`c.pair_id = ${pairId} AND c.status = 'active'`);

/** Abre uma conversa; `null` se o par já tem uma ativa (índice único parcial). */
export async function startConversation(
  db: Db,
  pairId: string,
  mode: WarmupMode,
  turnsTarget: number,
  lines: ScriptLine[],
  costUsd: number,
  meta: { themeId: string | null; model: string; paid: boolean },
): Promise<Conversation | null> {
  const [r] = await exec(
    db,
    sql`INSERT INTO mag.warmup_conversations (pair_id, mode, turns_target, lines, cost_usd, theme_id, model, paid)
      VALUES (${pairId}, ${mode}, ${turnsTarget}, ${JSON.stringify(lines)}::jsonb, ${costUsd}, ${meta.themeId}, ${meta.model}, ${meta.paid})
      ON CONFLICT DO NOTHING RETURNING id`,
  );
  return r ? getConversation(db, String(r.id)) : null;
}

/** Reserva a vez de forma atômica (antes de enviar): só passa quem vê `turns_done = expected` numa conversa ativa. */
export async function claimTurn(db: Db, id: string, speaker: string, expected: number): Promise<boolean> {
  const rows = await exec(
    db,
    sql`UPDATE mag.warmup_conversations SET last_speaker = ${speaker}, turns_done = ${expected + 1}, last_at = now()
      WHERE id = ${id} AND status = 'active' AND turns_done = ${expected} RETURNING id`,
  );
  return rows.length > 0;
}

/** Encerra a conversa e grava o próximo horário do par (`nextAt`). */
export async function endConversation(db: Db, id: string, status: 'done' | 'canceled', nextAt: Date | null): Promise<void> {
  const [r] = await exec(
    db,
    sql`UPDATE mag.warmup_conversations SET status = ${status}, ended_at = now() WHERE id = ${id} AND status = 'active' RETURNING pair_id`,
  );
  if (r) {
    await exec(
      db,
      sql`UPDATE mag.warmup_pairs SET next_at = ${nextAt ? nextAt.toISOString() : null}::timestamptz WHERE id = ${String(r.pair_id)}`,
    );
  }
}

/** `paid`: a fala veio de modelo pago → a conversa passa a contar no teto do pago (gratuito custa 0, a soma segue exata). */
export async function addCost(db: Db, convId: string, usd: number, paid = false): Promise<void> {
  await exec(db, sql`UPDATE mag.warmup_conversations SET cost_usd = cost_usd + ${usd}, paid = paid OR ${paid} WHERE id = ${convId}`);
}

/** Roda `fn` só se ninguém mais estiver no agendador (trava consultiva de transação); trava ocupada → null. */
export async function withTickLock<T>(db: Db, fn: () => Promise<T>): Promise<T | null> {
  return db.transaction(async (tx) => {
    const [r] = await exec(tx, sql`SELECT pg_try_advisory_xact_lock(7340211) AS ok`);
    return r?.ok ? fn() : null;
  });
}

export async function staleConversations(db: Db, olderThan: Date): Promise<string[]> {
  const rows = await exec(
    db,
    sql`SELECT id FROM mag.warmup_conversations WHERE status = 'active' AND last_at < ${olderThan.toISOString()}::timestamptz`,
  );
  return rows.map((r) => String(r.id));
}

export async function logMessage(
  db: Db,
  m: { conversationId: string; from: string; to: string; body: string; status: 'sent' | 'failed'; error?: string; costUsd?: number },
): Promise<void> {
  await exec(
    db,
    sql`INSERT INTO mag.warmup_messages (conversation_id, from_account, to_account, body, status, error, cost_usd)
      VALUES (${m.conversationId}, ${m.from}, ${m.to}, ${m.body}, ${m.status}, ${m.error ?? null}, ${m.costUsd ?? 0})`,
  );
}

/** Últimas `limit` falas enviadas da conversa, em ordem cronológica. */
export async function history(db: Db, convId: string, limit = 10): Promise<{ from: string; text: string }[]> {
  const rows = await exec(
    db,
    sql`SELECT from_account, body FROM (
      SELECT id, from_account, body FROM mag.warmup_messages
      WHERE conversation_id = ${convId} AND status = 'sent' ORDER BY id DESC LIMIT ${limit}
    ) t ORDER BY id`,
  );
  return rows.map((r) => ({ from: String(r.from_account), text: String(r.body) }));
}

/** Custo de IA do dia de Brasília (`day` = YYYY-MM-DD, como `appDay`): conversas por started_at (o custo da IA mora na conversa). */
export async function costToday(db: Db, day: string): Promise<number> {
  const [r] = await exec(
    db,
    sql`SELECT COALESCE(sum(cost_usd), 0)::float8 AS total FROM mag.warmup_conversations WHERE ${inDay('started_at', day)}`,
  );
  return num(r?.total);
}

/** Custo só das conversas pagas no dia UTC de `now` (00:00 UTC = 21:00 de Brasília): o mesmo dia da pausa por teto/cota. */
export async function paidCostToday(db: Db, now: Date): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 86_400_000);
  const [r] = await exec(
    db,
    sql`SELECT COALESCE(sum(cost_usd), 0)::float8 AS total FROM mag.warmup_conversations
      WHERE paid AND started_at >= ${start.toISOString()}::timestamptz AND started_at < ${end.toISOString()}::timestamptz`,
  );
  return num(r?.total);
}

export type Theme = { id: string; name: string; allowed: string; avoid: string; active: boolean };

export async function listThemes(db: Db, onlyActive = false): Promise<Theme[]> {
  const rows = await exec(
    db,
    sql`SELECT id, name, allowed, avoid, active FROM mag.warmup_themes
      WHERE ${onlyActive ? sql`active` : sql`true`} ORDER BY position, name`,
  );
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), allowed: String(r.allowed), avoid: String(r.avoid), active: Boolean(r.active) }));
}

export async function saveTheme(db: Db, t: { id?: string; name: string; allowed: string; avoid?: string }): Promise<string> {
  const avoid = t.avoid ?? '';
  const [r] = t.id
    ? await exec(
        db,
        sql`UPDATE mag.warmup_themes SET name = ${t.name}, allowed = ${t.allowed}, avoid = ${avoid}
          WHERE id = ${t.id} RETURNING id`,
      )
    : await exec(
        db,
        sql`INSERT INTO mag.warmup_themes (name, allowed, avoid, position)
          VALUES (${t.name}, ${t.allowed}, ${avoid}, (SELECT COALESCE(max(position), 0) + 1 FROM mag.warmup_themes))
          RETURNING id`,
      );
  if (!r) throw new Error('tema não encontrado');
  return String(r.id);
}

export async function setThemeActive(db: Db, id: string, active: boolean): Promise<void> {
  await exec(db, sql`UPDATE mag.warmup_themes SET active = ${active} WHERE id = ${id}`);
}

/** "Já salvei os contatos" vale por chip. */
export async function confirmChipContacts(db: Db, accountId: string): Promise<void> {
  await exec(db, sql`UPDATE mag.warmup_chips SET contacts_confirmed_at = now() WHERE account_id = ${accountId}`);
}

/** Cria o par de cada dupla de chips ativos (a<b) e reativa par inativo dela; devolve quantos criou. */
export async function syncPairs(db: Db): Promise<number> {
  const rows = await exec(
    db,
    sql`INSERT INTO mag.warmup_pairs (account_a, account_b)
      SELECT x.account_id, y.account_id FROM mag.warmup_chips x
      JOIN mag.warmup_chips y ON x.account_id < y.account_id AND y.active
      WHERE x.active
      ON CONFLICT (account_a, account_b) DO NOTHING RETURNING id`,
  );
  await exec(
    db,
    sql`UPDATE mag.warmup_pairs p SET active = true WHERE NOT p.active
      AND EXISTS (SELECT 1 FROM mag.warmup_chips c WHERE c.account_id = p.account_a AND c.active)
      AND EXISTS (SELECT 1 FROM mag.warmup_chips c WHERE c.account_id = p.account_b AND c.active)`,
  );
  return rows.length;
}

export type ChipStats = { accountId: string; day: number; sentToday: number; partnersToday: string[]; inConversation: boolean };

/** Números do agendador por chip ativo. `day` (Brasília, YYYY-MM-DD) recorta o "hoje"; `now` conta os dias no maturador. */
export async function chipStats(db: Db, day: string, now: Date): Promise<Map<string, ChipStats>> {
  const rows = await exec(
    db,
    sql`SELECT c.account_id,
        (floor(extract(epoch FROM ${now.toISOString()}::timestamptz - c.started_at) / 86400)::int + 1) AS day,
        (SELECT count(*)::int FROM mag.warmup_messages m
          WHERE m.from_account = c.account_id AND m.status = 'sent' AND ${inDay('m.created_at', day)}) AS sent_today,
        COALESCE((SELECT array_agg(DISTINCT CASE WHEN m.from_account = c.account_id THEN m.to_account::text ELSE m.from_account::text END)
          FROM mag.warmup_messages m
          WHERE (m.from_account = c.account_id OR m.to_account = c.account_id) AND m.status = 'sent'
            AND ${inDay('m.created_at', day)}), ARRAY[]::text[]) AS partners,
        EXISTS (SELECT 1 FROM mag.warmup_conversations v JOIN mag.warmup_pairs p ON p.id = v.pair_id
          WHERE v.status = 'active' AND c.account_id IN (p.account_a, p.account_b)) AS in_conv
      FROM mag.warmup_chips c WHERE c.active`,
  );
  return new Map(
    rows.map((r) => [
      String(r.account_id),
      {
        accountId: String(r.account_id),
        day: Math.max(1, num(r.day)),
        sentToday: num(r.sent_today),
        partnersToday: (r.partners as string[]).map(String),
        inConversation: Boolean(r.in_conv),
      },
    ]),
  );
}

/** Pares que podem conversar agora (os dois chips ativos e cada um com contatos confirmados depois de o outro entrar, sem conversa ativa, `next_at` vencido), do mais parado ao mais recente. */
export async function candidatePairs(db: Db, now: Date): Promise<(PairRow & { lastThemeId: string | null; lastStartedAt: Date | null })[]> {
  const rows = await exec(
    db,
    sql`SELECT p.id, p.account_a, p.account_b, p.next_at, l.theme_id AS last_theme_id, l.started_at AS last_started_at
      FROM mag.warmup_pairs p
      JOIN mag.warmup_chips ca ON ca.account_id = p.account_a AND ca.active
      JOIN mag.warmup_chips cb ON cb.account_id = p.account_b AND cb.active
        AND ca.contacts_confirmed_at >= cb.created_at AND cb.contacts_confirmed_at >= ca.created_at
      LEFT JOIN LATERAL (SELECT theme_id, started_at FROM mag.warmup_conversations c
        WHERE c.pair_id = p.id ORDER BY started_at DESC LIMIT 1) l ON true
      WHERE p.active AND (p.next_at IS NULL OR p.next_at <= ${now.toISOString()}::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM mag.warmup_conversations c WHERE c.pair_id = p.id AND c.status = 'active')
      ORDER BY l.started_at NULLS FIRST, p.created_at`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    a: String(r.account_a),
    b: String(r.account_b),
    nextAt: date(r.next_at),
    lastThemeId: r.last_theme_id == null ? null : String(r.last_theme_id),
    lastStartedAt: date(r.last_started_at),
  }));
}

export async function activeConversations(db: Db): Promise<number> {
  const [r] = await exec(db, sql`SELECT count(*)::int AS n FROM mag.warmup_conversations WHERE status = 'active'`);
  return num(r?.n);
}

/** Pausa por cota/teto até `until` (null limpa). */
export async function setPause(db: Db, until: Date | null, reason: string | null): Promise<void> {
  await exec(
    db,
    sql`UPDATE mag.warmup_settings SET paused_until = ${until ? until.toISOString() : null}::timestamptz,
      pause_reason = ${reason}, updated_at = now() WHERE id = 1`,
  );
}

/** Rodízio de modelos: incrementa `model_rr` de forma atômica e devolve o valor anterior. */
/** Vez atual do rodízio, sem avançar (só avança quando a conversa começa de fato: `nextModelSlot`). */
export async function peekModelSlot(db: Db): Promise<number> {
  const [r] = await exec(db, sql`SELECT model_rr FROM mag.warmup_settings WHERE id = 1`);
  return num(r?.model_rr);
}

export async function nextModelSlot(db: Db): Promise<number> {
  const [r] = await exec(
    db,
    sql`UPDATE mag.warmup_settings SET model_rr = model_rr + 1 WHERE id = 1 RETURNING model_rr - 1 AS slot`,
  );
  return num(r?.slot);
}

export async function chipAddress(db: Db, accountId: string): Promise<{ session: string; chatId: string } | null> {
  const [r] = await exec(db, sql`SELECT session_name, jid FROM mag.wa_accounts WHERE id = ${accountId}`);
  const d = digitsOf(r?.jid as string | null);
  return r?.session_name && d ? { session: String(r.session_name), chatId: `${d}@c.us` } : null;
}

/** A mensagem recebida em `session` veio do outro chip de um par ativo? (confirmação dos contatos não importa aqui) */
export async function matchPair(
  db: Db,
  m: { session: string; chatId: string; altPhone?: string | null },
): Promise<{ accountId: string; peerId: string; pairId: string } | null> {
  const [acc] = await exec(db, sql`SELECT id FROM mag.wa_accounts WHERE session_name = ${m.session}`);
  if (!acc) return null;
  const me = String(acc.id);
  const peers = await exec(
    db,
    sql`SELECT p.id AS pair_id, w.id AS peer_id, w.jid, w.lid FROM mag.warmup_pairs p
      JOIN mag.wa_accounts w ON w.id = CASE WHEN p.account_a = ${me} THEN p.account_b ELSE p.account_a END
      WHERE p.active AND (p.account_a = ${me} OR p.account_b = ${me})`,
  );
  const isLid = m.chatId.endsWith('@lid');
  const incoming = new Set<string>();
  for (const s of [isLid ? '' : m.chatId, m.altPhone]) {
    const d = digitsOf(s);
    if (d) for (const v of variants(d)) incoming.add(v);
  }
  const lidIn = isLid ? m.chatId.split('@')[0] : null;
  for (const r of peers) {
    const phone = digitsOf(r.jid as string | null);
    const byPhone = phone !== '' && [...variants(phone)].some((v) => incoming.has(v));
    const byLid = !!lidIn && !!r.lid && String(r.lid).split('@')[0] === lidIn;
    if (byPhone || byLid) return { accountId: me, peerId: String(r.peer_id), pairId: String(r.pair_id) };
  }
  return null;
}

export type WarmupPageData = Awaited<ReturnType<typeof pageData>>;

/** Dados da tela: chips, pares, últimas 30 mensagens, custo de hoje e contas fora do maturador. */
export async function pageData(db: Db, day: string, now: Date = new Date()) {
  const chips = await exec(
    db,
    sql`SELECT c.account_id, a.name, a.status, c.active, c.paused_reason, (c.contacts_confirmed_at IS NOT NULL) AS had_confirmed,
        (c.contacts_confirmed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mag.warmup_chips o
          WHERE o.account_id <> c.account_id AND o.active AND o.created_at > c.contacts_confirmed_at)) AS contacts_ok,
        floor(extract(epoch FROM now() - c.started_at) / 86400)::int AS days,
        (SELECT count(*)::int FROM mag.warmup_messages m
          WHERE m.from_account = c.account_id AND m.status = 'sent' AND ${inDay('m.created_at', day)}) AS sent_today
      FROM mag.warmup_chips c JOIN mag.wa_accounts a ON a.id = c.account_id ORDER BY c.created_at`,
  );
  const pairs = await exec(
    db,
    sql`SELECT p.id, na.name AS name_a, nb.name AS name_b, p.active, p.contacts_confirmed_at, p.next_at,
        EXISTS (SELECT 1 FROM mag.warmup_chips ca JOIN mag.warmup_chips cb ON cb.account_id = p.account_b AND cb.active
          WHERE ca.account_id = p.account_a AND ca.active
            AND ca.contacts_confirmed_at >= cb.created_at AND cb.contacts_confirmed_at >= ca.created_at) AS ready,
        EXISTS (SELECT 1 FROM mag.warmup_conversations c WHERE c.pair_id = p.id AND c.status = 'active') AS talking
      FROM mag.warmup_pairs p
      JOIN mag.wa_accounts na ON na.id = p.account_a JOIN mag.wa_accounts nb ON nb.id = p.account_b
      ORDER BY p.created_at`,
  );
  const messages = await exec(
    db,
    sql`SELECT m.id, fa.name AS from_name, ta.name AS to_name, m.body, m.created_at, m.status, t.name AS theme_name, v.model, v.paid
      FROM mag.warmup_messages m
      LEFT JOIN mag.warmup_conversations v ON v.id = m.conversation_id
      LEFT JOIN mag.warmup_themes t ON t.id = v.theme_id
      JOIN mag.wa_accounts fa ON fa.id = m.from_account JOIN mag.wa_accounts ta ON ta.id = m.to_account
      ORDER BY m.id DESC LIMIT 30`,
  );
  const outside = await exec(
    db,
    sql`SELECT a.id, a.name, a.status FROM mag.wa_accounts a
      WHERE NOT EXISTS (SELECT 1 FROM mag.warmup_chips c WHERE c.account_id = a.id) ORDER BY a.name`,
  );
  return {
    chips: chips.map((r) => ({
      accountId: String(r.account_id),
      name: String(r.name),
      status: String(r.status),
      active: Boolean(r.active),
      pausedReason: (r.paused_reason as string | null) ?? null,
      days: num(r.days),
      sentToday: num(r.sent_today),
      contactsConfirmed: Boolean(r.contacts_ok),
      hadConfirmed: Boolean(r.had_confirmed),
      day: num(r.days) + 1,
      goal: rampFor(num(r.days) + 1).goal,
      partnerLimit: rampFor(num(r.days) + 1).partners,
    })),
    pairs: pairs.map((r) => ({
      id: String(r.id),
      nameA: String(r.name_a),
      nameB: String(r.name_b),
      active: Boolean(r.active),
      confirmed: r.contacts_confirmed_at != null,
      talking: Boolean(r.talking),
      nextAt: date(r.next_at),
    })),
    messages: messages.map((r) => ({
      id: String(r.id),
      from: String(r.from_name),
      to: String(r.to_name),
      text: String(r.body),
      at: new Date(r.created_at as string),
      status: String(r.status),
      theme: (r.theme_name as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      paid: Boolean(r.paid),
    })),
    costToday: await costToday(db, day),
    paidToday: await paidCostToday(db, now),
    themes: await listThemes(db),
    settings: await getSettings(db),
    pairsTotal: pairs.length,
    pairsReady: pairs.filter((r) => r.active && r.ready).length,
    outside: outside.map((r) => ({ accountId: String(r.id), name: String(r.name), status: String(r.status) })),
  };
}
