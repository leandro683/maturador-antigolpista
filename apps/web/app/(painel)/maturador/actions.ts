'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  confirmChipContactsService,
  saveModelsService,
  saveSettingsService,
  saveThemeService,
  setEnabledService,
  setParticipationService,
  setThemeActiveService,
} from '@/server/services/warmup';

/** Volta p/ /maturador com o aviso do resultado. */
function back(r: { ok: true; message?: string } | { ok: false; error: string }): never {
  const qs = new URLSearchParams();
  if (!r.ok) qs.set('erro', r.error);
  else if (r.message) qs.set('msg', r.message);
  revalidatePath('/maturador');
  redirect(`/maturador?${qs.toString()}`);
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '');
/** Aceita vírgula decimal. Vazio = undefined (o schema recusa); NaN também é recusado pelo schema. */
const num = (fd: FormData, k: string) => (str(fd, k).trim() === '' ? undefined : Number(str(fd, k).replace(',', '.')));
/** Janela de horário: campo vazio = sem janela (null). */
const hourOrNull = (fd: FormData, k: string) => (str(fd, k).trim() === '' ? null : num(fd, k));

export async function saveSettingsAction(fd: FormData) {
  back(
    await saveSettingsService({
      mode: str(fd, 'mode'),
      gapMinSec: num(fd, 'gapMinSec'),
      gapMaxSec: num(fd, 'gapMaxSec'),
      typingCps: num(fd, 'typingCps'),
      pauseMinMin: num(fd, 'pauseMinMin'),
      pauseMaxMin: num(fd, 'pauseMaxMin'),
      turnsMin: num(fd, 'turnsMin'),
      turnsMax: num(fd, 'turnsMax'),
      windowStart: hourOrNull(fd, 'windowStart'),
      windowEnd: hourOrNull(fd, 'windowEnd'),
      activeCap: num(fd, 'activeCap'),
    }),
  );
}

export async function setEnabledAction(fd: FormData) {
  back(await setEnabledService(str(fd, 'on') === '1'));
}

export async function saveModelsAction(fd: FormData) {
  back(
    await saveModelsService({
      freeModels: fd.getAll('freeModels').map(String),
      paidModels: fd.getAll('paidModels').map(String),
      paidBackup: str(fd, 'paidBackup') === '1',
      dailyCapUsd: num(fd, 'dailyCapUsd'),
    }),
  );
}

export async function saveThemeAction(fd: FormData) {
  back(await saveThemeService({ id: str(fd, 'id') || undefined, name: str(fd, 'name'), allowed: str(fd, 'allowed') }));
}

export async function setThemeActiveAction(fd: FormData) {
  back(await setThemeActiveService(str(fd, 'id'), str(fd, 'on') === '1'));
}

export async function setParticipationAction(fd: FormData) {
  back(await setParticipationService(str(fd, 'accountId'), str(fd, 'on') === '1'));
}

export async function confirmChipContactsAction(fd: FormData) {
  back(await confirmChipContactsService(str(fd, 'accountId')));
}
