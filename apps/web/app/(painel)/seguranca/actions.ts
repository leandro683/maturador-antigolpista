'use server';

import { revalidatePath } from 'next/cache';
import type { CsvEntry } from '@mag/module-blacklist/csv';
import type { AntiHackerInput, FindingOp, SecuritySettings } from '@mag/module-security';
import * as svc from '@/server/services/security';

/** Server actions de segurança (incidentes, anti-spam, anti-golpista e colaboradores da operação). */

const after = <T>(r: svc.Result<T>, ...paths: string[]) => {
  if (r.ok) for (const p of paths) revalidatePath(p);
  return r;
};

export async function resolveIncidentsAction(ids: string[], status: 'ignored' | 'reverted') {
  return after(await svc.resolve(ids, status), '/seguranca');
}

export async function exportIncidentsAction(sp: Record<string, string>) {
  return svc.exportIncidents(sp);
}

export async function antiSpamOptInAction(campaignId: string, enabled: boolean) {
  return after(await svc.optIn(campaignId, enabled), '/seguranca', `/grupos/${campaignId}/anti-golpista`);
}

export async function saveAntiHackerAction(campaignId: string, input: AntiHackerInput & { antiSpamOptIn?: boolean }) {
  // a página do formulário entra na lista: o form não faz mais router.refresh() (2º render completo)
  return after(
    await svc.saveAntiHackerConfig(campaignId, input),
    `/grupos/${campaignId}`,
    `/grupos/${campaignId}/anti-golpista`,
    '/seguranca',
  );
}

// anti-impostor: só devolvem o hash; a lista de fotos é salva junto com o resto da config (saveAntiHackerAction)
type PhotoHash = { ok: true; hash: string } | { ok: false; error: string };
const hashOnly = (r: svc.Result<{ hash: string }>): PhotoHash => (r.ok ? { ok: true, hash: r.data.hash } : r);

export async function impersonationPhotoFromFileAction(form: FormData): Promise<PhotoHash> {
  return hashOnly(await svc.impersonationPhotoFromFile(form));
}

export async function impersonationPhotoFromNumberAction(campaignId: string, phone: string): Promise<PhotoHash> {
  return hashOnly(await svc.impersonationPhotoFromNumber(campaignId, phone));
}

export async function addCollaboratorAction(campaignId: string, value: string, name: string, kind: 'phone' | 'lid') {
  return after(await svc.addCollab(campaignId, value, name, kind), `/grupos/${campaignId}/colaboradores`);
}

export async function importCollaboratorsAction(campaignId: string, entries: CsvEntry[]) {
  return after(await svc.importCollabs(campaignId, entries), `/grupos/${campaignId}/colaboradores`);
}

export async function removeCollaboratorsAction(campaignId: string, ids: string[]) {
  return after(await svc.removeCollabs(campaignId, ids), `/grupos/${campaignId}/colaboradores`);
}

// Analisar grupos
export async function startScanAction(campaignId: string, messageLimit: number, checkProfiles = false) {
  return after(await svc.startGroupScan(campaignId, messageLimit, checkProfiles), '/seguranca', `/grupos/${campaignId}/anti-golpista`);
}

export async function cancelScanAction(scanId: string) {
  return after(await svc.cancelGroupScan(scanId), '/seguranca');
}

export async function findingsAction(ids: string[], op: FindingOp, block = false) {
  return after(await svc.actOnScanFindings(ids, op, block), '/seguranca');
}

// Interruptores globais
export async function saveGlobalSecurityAction(patch: Partial<SecuritySettings>) {
  return after(await svc.saveGlobalSecurity(patch), '/seguranca');
}

export async function verifyCollaboratorAction(campaignId: string, query: string) {
  return after(await svc.verify(campaignId, query), `/grupos/${campaignId}/colaboradores`);
}

// Página pública
export async function saveVerifyPageAction(campaignId: string, input: { enabled: boolean; eventName: string }) {
  return after(await svc.saveVerifyPage(campaignId, input), `/grupos/${campaignId}/colaboradores`);
}
