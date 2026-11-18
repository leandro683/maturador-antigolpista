'use server';

import { revalidatePath } from 'next/cache';
import { fail, ok, type ActionResult } from '@mag/module-blacklist/action-result';
import type { CsvEntry } from '@mag/module-blacklist/csv';
import { normalizeEntry } from '@mag/module-blacklist/normalize';
import * as svc from '@mag/module-blacklist/service';
import { getSession } from '@/lib/auth';
import { serverDb } from '@/server/db';

/** Só o dono mexe nas listas. Sem redirect: o erro vira mensagem na tela (o catch de cada ação engoliria o redirect). */
async function writerDb() {
  const { user } = await getSession();
  if (!user) throw new Error('sem permissão para alterar');
  return serverDb();
}

const MAX_IMPORT_ROWS = 5_000;

const done = <T>(data: T) => {
  revalidatePath('/bloqueados');
  return ok(data);
};

export async function createList(name: string): Promise<ActionResult<{ id: string }>> {
  try {
    const l = await svc.createList(await writerDb(), { name });
    return done({ id: l.id });
  } catch (e) {
    return fail(e);
  }
}

export async function toggleList(id: string, disabled: boolean): Promise<ActionResult<null>> {
  try {
    await svc.updateList(await writerDb(), id, { disabled });
    return done(null);
  } catch (e) {
    return fail(e);
  }
}

export async function deleteList(id: string): Promise<ActionResult<null>> {
  try {
    await svc.deleteList(await writerDb(), id);
    return done(null);
  } catch (e) {
    return fail(e);
  }
}

export async function addNumber(
  listId: string,
  value: string,
  kind: 'phone' | 'lid',
  name: string,
): Promise<ActionResult<null>> {
  try {
    await svc.addNumber(await writerDb(), listId, { value, kind, name });
    return done(null);
  } catch (e) {
    return fail(e);
  }
}

/** Entradas vêm parseadas do navegador; normaliza de novo no servidor (não confia no cliente). */
export async function importCsv(
  listId: string,
  entries: CsvEntry[],
): Promise<ActionResult<{ inserted: number; skipped: number }>> {
  try {
    const db = await writerDb(); // sessão primeiro: sem login nada é processado
    // o corpo de uma action no Next passa de 1 MB com ~8 mil linhas (limite padrão); 5 mil cabem com folga
    if (entries.length > MAX_IMPORT_ROWS) return { ok: false, error: 'máximo 5.000 linhas por importação' };
    const clean = entries.flatMap((e): CsvEntry[] => {
      const k = e.lid ? normalizeEntry(e.lid, 'lid') : e.number ? normalizeEntry(e.number, 'phone') : null;
      return k ? [{ ...k, ...(e.name ? { name: String(e.name).slice(0, 120) } : {}) }] : [];
    });
    const r = await svc.importNumbers(db, listId, clean);
    return done({ inserted: r.inserted, skipped: entries.length - r.inserted });
  } catch (e) {
    return fail(e);
  }
}

export async function removeNumbers(ids: string[]): Promise<ActionResult<null>> {
  try {
    await svc.removeNumbers(await writerDb(), ids);
    return done(null);
  } catch (e) {
    return fail(e);
  }
}

export async function addAdmin(value: string, label: string): Promise<ActionResult<null>> {
  try {
    await svc.addAdminNumber(await writerDb(), { value, label });
    return done(null);
  } catch (e) {
    return fail(e);
  }
}

export async function removeAdmin(id: string): Promise<ActionResult<null>> {
  try {
    await svc.removeAdminNumber(await writerDb(), id);
    return done(null);
  } catch (e) {
    return fail(e);
  }
}
