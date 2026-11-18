import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { campaigns, groups } from '@mag/db/schema';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import { incidents } from '@mag/module-security';
import type { WarmupDeps } from '@mag/module-warmup';
import { mapWahaEvent, type WahaWebhook } from '@mag/wa-engine';
import { FakeEngine } from '@mag/wa-engine/fake';
import { buildHandlers } from '../src/handlers';
import type { WaEventHandler } from '../src/processors/wa-events';
import { seedCampaign } from './helpers';

// Aqui o anti-golpista é o de verdade (sem espiões): o que o dono grava depende do que ele julgou.
const HACKER = '5511999990002';
const ADMIN = '5511999990003';
const OFFICIAL = 'Lançamento #1';

/** group.update do GOWS com o nome novo e o autor (telefone). */
function renameWebhook(
  gid: string,
  session: string,
  subject: string,
  authorPhone: string,
  atSec = Math.floor(Date.now() / 1000),
  description?: string,
): WahaWebhook {
  return {
    id: 'evt',
    timestamp: atSec,
    event: 'group.v2.update',
    session,
    engine: 'GOWS',
    payload: {
      timestamp: atSec,
      group: { id: gid, subject, ...(description !== undefined ? { description } : {}) },
      _data: { JID: gid, Sender: `${authorPhone}@lid`, SenderPN: `${authorPhone}@s.whatsapp.net`, Topic: null },
    },
  } as unknown as WahaWebhook;
}

describe.skipIf(!PG_URL)('group.update: o dono só grava o que o anti-golpista aceitou (Postgres real)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  const engine = new FakeEngine();
  let h: Record<string, WaEventHandler>;

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
    h = buildHandlers({
      db,
      engine,
      warmup: { db, schedule: vi.fn(async () => {}) } as unknown as WarmupDeps,
      log: () => {},
    }) as never;
  });
  afterAll(async () => drop?.());

  /** Grupo com nome oficial gravado; `antiHacker` é a config da campanha. */
  async function cenario(antiHacker: Record<string, unknown>, description: string | null = 'Grupo oficial') {
    const t = await seedCampaign(db, engine, 1, antiHacker);
    const gid = t.gs[0]!.gid;
    await db.update(groups).set({ name: OFFICIAL, description }).where(eq(groups.gid, gid));
    const stored = async () => (await db.select().from(groups).where(eq(groups.gid, gid)))[0]!;
    const accountPhone = t.acc.jid!.replace('@c.us', '');
    const rename = async (subject: string, author: string, stale = false, atSec?: number, description?: string) => {
      const raw = renameWebhook(gid, t.acc.sessionName, subject, author, atSec, description);
      return h['group.update']!(mapWahaEvent(raw) as never, { raw, stale });
    };
    const incidentCount = async () =>
      (await db.select({ id: incidents.id }).from(incidents).where(eq(incidents.gid, gid))).length;
    return { t, gid, stored, rename, accountPhone, incidentCount };
  }

  it('golpista renomeia com a proteção ligada: o nome gravado não muda (e o WhatsApp volta ao oficial)', async () => {
    const { gid, stored, rename } = await cenario({ enabled: true });
    await rename('GANHE PIX AQUI', HACKER);
    expect((await stored()).name).toBe(OFFICIAL);
    expect(engine.groups.get(gid)!.subject).toBe(OFFICIAL);
  });

  it('golpista com a reversão desligada: nada é revertido e o nome gravado segue o oficial', async () => {
    const { stored, rename } = await cenario({ enabled: true, revertNameDescriptionChange: false });
    await rename('GANHE PIX AQUI', HACKER);
    expect((await stored()).name).toBe(OFFICIAL);
  });

  it('golpista com a análise em simulação (dry-run): o nome gravado não muda', async () => {
    const { stored, rename } = await cenario({ enabled: true, dryRun: true });
    await rename('GANHE PIX AQUI', HACKER);
    expect((await stored()).name).toBe(OFFICIAL);
  });

  it('autor desconhecido (sem remetente no evento): não vira o nome de confiança', async () => {
    const { t, gid, stored } = await cenario({ enabled: true });
    const raw = renameWebhook(gid, t.acc.sessionName, 'GANHE PIX AQUI', HACKER);
    delete (raw.payload as { _data?: unknown })._data;
    await h['group.update']!(mapWahaEvent(raw) as never, { raw, stale: false });
    expect((await stored()).name).toBe(OFFICIAL);
  });

  it('admin autorizado da lista renomeia: o nome gravado acompanha', async () => {
    const { stored, rename } = await cenario({ enabled: true, allowedAdminNumbers: [`+${ADMIN}`] });
    await rename('Lançamento #2', ADMIN);
    expect((await stored()).name).toBe('Lançamento #2');
  });

  it('conta da própria operação renomeia: o nome gravado acompanha', async () => {
    const { stored, rename, accountPhone } = await cenario({ enabled: true });
    await rename('Nome pelo painel', accountPhone);
    expect((await stored()).name).toBe('Nome pelo painel');
  });

  it('proteção desligada: o nome gravado acompanha o WhatsApp', async () => {
    const { stored, rename } = await cenario({ enabled: false });
    await rename('Qualquer nome', HACKER);
    expect((await stored()).name).toBe('Qualquer nome');
  });

  it('grupo sem nenhuma configuração do anti-golpista (campanha antiga) também acompanha', async () => {
    const t = await seedCampaign(db, engine, 1);
    await db.update(campaigns).set({ antiHacker: null }).where(eq(campaigns.id, t.camp));
    const gid = t.gs[0]!.gid;
    const raw = renameWebhook(gid, t.acc.sessionName, 'Outro', HACKER);
    await h['group.update']!(mapWahaEvent(raw) as never, { raw, stale: false });
    expect((await db.select().from(groups).where(eq(groups.gid, gid)))[0]!.name).toBe('Outro');
  });

  it('o convite continua sendo gravado mesmo quando o nome foi barrado', async () => {
    const { t, gid, stored } = await cenario({ enabled: true });
    const raw = renameWebhook(gid, t.acc.sessionName, 'GANHE PIX AQUI', HACKER);
    const e = { ...mapWahaEvent(raw)!, inviteCode: 'XYZ789' };
    await h['group.update']!(e as never, { raw, stale: false });
    const g = await stored();
    expect(g.name).toBe(OFFICIAL);
    expect(g.inviteCode).toBe('XYZ789');
  });

  it('evento atrasado de golpista: nada é gravado', async () => {
    const { stored, rename } = await cenario({ enabled: true });
    await rename('GANHE PIX AQUI', HACKER, true);
    expect((await stored()).name).toBe(OFFICIAL);
  });

  it('descrição de autor fora da lista com a descrição gravada vazia: não vira a de confiança e é revertida', async () => {
    const { gid, stored, rename, incidentCount } = await cenario({ enabled: true }, null);
    const spy = vi.spyOn(engine, 'setDescription');
    await rename(OFFICIAL, HACKER, false, undefined, 'Entre em http://golpe.example/pix');
    expect((await stored()).description).toBeNull();
    expect(await incidentCount()).toBe(1);
    expect(spy).toHaveBeenCalledWith(expect.any(String), gid, '');
    spy.mockRestore();
  });

  it('descrição de autor fora da lista com a reversão desligada: registra e não grava', async () => {
    const { stored, rename, incidentCount } = await cenario({ enabled: true, revertNameDescriptionChange: false }, null);
    await rename(OFFICIAL, HACKER, false, undefined, 'Entre em http://golpe.example/pix');
    expect((await stored()).description).toBeNull();
    expect(await incidentCount()).toBe(1);
  });

  it('descrição gravada vazia e admin da lista muda a descrição: a nova vira a de confiança', async () => {
    const { stored, rename } = await cenario({ enabled: true, allowedAdminNumbers: [`+${ADMIN}`] }, null);
    await rename(OFFICIAL, ADMIN, false, undefined, 'Regras do grupo');
    expect((await stored()).description).toBe('Regras do grupo');
  });

  it('o mesmo nome de golpista repetido uma hora depois é revertido e registrado de novo', async () => {
    const { gid, stored, rename, incidentCount } = await cenario({ enabled: true });
    const t0 = Math.floor(Date.now() / 1000);
    await rename('GANHE PIX AQUI', HACKER, false, t0);
    expect(await incidentCount()).toBe(1);
    engine.groups.get(gid)!.subject = 'GANHE PIX AQUI'; // ele renomeia de novo
    await rename('GANHE PIX AQUI', HACKER, false, t0 + 3600);
    expect(await incidentCount()).toBe(2);
    expect(engine.groups.get(gid)!.subject).toBe(OFFICIAL);
    expect((await stored()).name).toBe(OFFICIAL);
  });

  it('a mesma entrega repetida (reenvio do webhook) continua sendo um incidente só', async () => {
    const { rename, incidentCount } = await cenario({ enabled: true });
    const t0 = Math.floor(Date.now() / 1000);
    await rename('GANHE PIX AQUI', HACKER, false, t0);
    await rename('GANHE PIX AQUI', HACKER, false, t0);
    expect(await incidentCount()).toBe(1);
  });

  it('descrição que só chega no campo Topic de _data também é gravada quando o autor é da lista', async () => {
    const { t, gid, stored } = await cenario({ enabled: true, allowedAdminNumbers: [`+${ADMIN}`] });
    const raw = renameWebhook(gid, t.acc.sessionName, OFFICIAL, ADMIN);
    (raw.payload as { _data: { Topic: unknown } })._data.Topic = { Topic: 'Descrição nova' };
    await h['group.update']!(mapWahaEvent(raw) as never, { raw, stale: false });
    expect((await stored()).description).toBe('Descrição nova');
  });
});
