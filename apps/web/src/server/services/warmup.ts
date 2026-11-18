import 'server-only';
import {
  addChip,
  APPROVED_MODELS,
  confirmChipContacts,
  getSettings,
  lastConversationToday,
  NO_JID_MSG,
  pageData,
  pauseAll,
  saveSettings,
  saveTheme,
  setChipActive,
  setEnabled,
  setThemeActive,
  syncPairs,
  warmupLlmFromEnv,
  warmupSettingsSchema,
  util,
} from '@mag/module-warmup';
import { getSession, requireAdmin } from '@/lib/auth';
import { serverDb } from '../db';

/** Maturador de chips: tela /maturador. Gasta IA e mexe em números reais → só dono/admin. */

// sem redirect: o erro vira mensagem na tela (o redirect do requireAdmin seria engolido pelo catch de run)
async function assertOwner() {
  const s = await getSession();
  util.assertAdmin(s.user ? s.role : null);
}

const { WarmupError, appDay, publicError } = util;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: string, what: string) => {
  if (!UUID.test(v)) throw new WarmupError(`${what} inválido`);
  return v;
};

export async function warmupPage() {
  await requireAdmin(); // redireciona p/ /login
  const db = serverDb();
  const day = appDay(new Date());
  const data = await pageData(db, day);
  return { ...data, last: await lastConversationToday(db, day), llmReady: warmupLlmFromEnv(data.settings.model, process.env) !== null };
}

type Out = { ok: true; message?: string } | { ok: false; error: string };
async function run(fn: () => Promise<string | void>): Promise<Out> {
  try {
    await assertOwner();
    const message = await fn();
    return { ok: true, ...(message ? { message } : {}) };
  } catch (e) {
    return { ok: false, error: publicError(e) };
  }
}

/** Mescla `patch` nas configurações salvas, valida e grava. `enabled` é mantido: ligar/desligar é outro botão. */
async function mergeSettings(patch: Record<string, unknown>) {
  const db = serverDb();
  const cur = await getSettings(db);
  const { pausedUntil: _u, pauseReason: _r, ...keep } = cur;
  const p = warmupSettingsSchema.safeParse({ ...keep, ...patch, enabled: cur.enabled });
  if (!p.success) throw new WarmupError(p.error.issues.map((i) => i.message).join(' '));
  await saveSettings(db, p.data);
}

/** `input` = campos do formulário de tempo/modo (números já convertidos; janela vazia = null). O resto fica como está salvo. */
export const saveSettingsService = (input: Record<string, unknown>) =>
  run(async () => {
    await mergeSettings(input);
    return 'Configuração salva';
  });

/** Ordem de tentativa = ordem da lista aprovada (só a seleção vem da tela). */
const byApproved = (l: string[]) => [...APPROVED_MODELS.map((m) => m.slug).filter((x) => l.includes(x)), ...l.filter((x) => !APPROVED_MODELS.some((m) => m.slug === x))];

export const saveModelsService = (i: { freeModels: string[]; paidModels: string[]; paidBackup: boolean; dailyCapUsd: number | undefined }) =>
  run(async () => {
    await mergeSettings({ freeModels: byApproved(i.freeModels), paidModels: byApproved(i.paidModels), paidBackup: i.paidBackup, dailyCapUsd: i.dailyCapUsd });
    return 'Modelos salvos';
  });

export const saveThemeService = (i: { id?: string; name: string; allowed: string }) =>
  run(async () => {
    const name = i.name.trim();
    const allowed = i.allowed.trim();
    if (!name) throw new WarmupError('Informe o nome do tema.');
    if (!allowed) throw new WarmupError('Escreva o que os chips podem falar nesse tema.');
    if (name.length > 80 || allowed.length > 1000) throw new WarmupError('Tema longo demais.');
    await saveTheme(serverDb(), { id: i.id ? uuid(i.id, 'tema') : undefined, name, allowed });
    return 'Tema salvo';
  });

export const setThemeActiveService = (id: string, on: boolean) =>
  run(async () => {
    await setThemeActive(serverDb(), uuid(id, 'tema'), on);
    return on ? 'Tema ligado.' : 'Tema desligado.';
  });

export const confirmChipContactsService = (accountId: string) =>
  run(async () => {
    await confirmChipContacts(serverDb(), uuid(accountId, 'chip'));
    return 'Contatos confirmados.';
  });

export const setEnabledService = (on: boolean) =>
  run(async () => {
    const db = serverDb();
    if (on) {
      await setEnabled(db, true);
      return 'Maturador ligado.';
    }
    await pauseAll(db);
    return 'Maturador pausado. As falas pendentes foram descartadas.';
  });

/** "Participa" ligado = entra no maturador e os pares automáticos são refeitos; desligado = tirado por você. */
export const setParticipationService = (accountId: string, on: boolean) =>
  run(async () => {
    const db = serverDb();
    const id = uuid(accountId, 'chip');
    if (!on) {
      await setChipActive(db, id, false, 'tirado por você');
      return 'Chip tirado do maturador.';
    }
    // addChip lança Error simples quando a conta não tem número sincronizado: mostrar o motivo em PT
    await addChip(db, id).catch((e: unknown) => {
      if (e instanceof Error && e.message === NO_JID_MSG) throw new WarmupError(e.message);
      throw e;
    });
    await syncPairs(db);
    return 'Chip no maturador. Salve o número dos outros chips neste aparelho e confirme.';
  });
