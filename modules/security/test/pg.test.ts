import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type postgres from 'postgres';
import type { Db } from '@mag/db';
import { campaigns, groupParticipants, groups, waAccounts } from '@mag/db/schema';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import { isBlocked } from '../../blacklist/check';
import { addAdminNumber } from '../../blacklist/service';
import { shouldRejectJoin, setAntiSpamOptIn, ANTI_SPAM_LIST_NAME } from '../src/antispam';
import { campaignSecurity, saveAntiHacker } from '../src/campaign';
import {
  addCollaborator,
  importCollaborators,
  verificationCounts,
  verificationHistory,
  verifyNumber,
} from '../src/collaborators';
import { onMessage, onReaction } from '../src/handlers';
import { incidentsCsv, listIncidents, resolveIncidents, incidentsByNumber } from '../src/incidents';
import { ensureVerifyPage, PUBLIC_VERIFY_TITLE, publicVerify, publicVerifyPage, setVerifyPage } from '../src/public-verify';
import { DrizzleSecRepo } from '../src/repo';
import { ev, GID, HACKER, messageWebhook, reactionWebhook, setup } from './fixtures';

/** Integração com Postgres real (TEST_DATABASE_URL): migration + DrizzleSecRepo + anti-spam + colaboradores. */
describe.skipIf(!PG_URL)('anti-golpista no Postgres', () => {
  let db: Db;
  let sql: postgres.Sql;
  let drop: () => Promise<void>;
  let campA: string;
  let campB: string;
  let accMain: string;

  beforeAll(async () => {
    ({ db, sql, drop } = await freshDb());
    const [m] = await db
      .insert(waAccounts)
      .values({ name: 'Principal', sessionName: 'chip-01', jid: '5511999990001@c.us', status: 'active' })
      .returning();
    const [s] = await db
      .insert(waAccounts)
      .values({ name: 'Espiã', sessionName: 'spy1', status: 'active', rolePolicy: { role: 'spy' } })
      .returning();
    accMain = m!.id;
    const [a] = await db
      .insert(campaigns)
      .values({ name: 'Camp A', slug: 'sec-a', accountIds: [m!.id, s!.id] })
      .returning();
    const [b] = await db.insert(campaigns).values({ name: 'Camp B', slug: 'sec-b' }).returning();
    campA = a!.id;
    campB = b!.id;
    await db.insert(groups).values({
      campaignId: campA,
      waAccountId: accMain,
      name: 'Camp A #1',
      gid: GID,
      settings: { announce: true },
    });
  });
  afterAll(async () => drop?.());

  it('ligar anti-hacker sem números administrativos é recusado; com eles, salva (merge no jsonb)', async () => {
    await expect(saveAntiHacker(db, campA, { enabled: true })).rejects.toThrow(/números administrativos/);
    await addAdminNumber(db, { value: '5511999990003', label: 'Equipe' });
    await saveAntiHacker(db, campA, { enabled: true, removeAuthor: true, antiSpamOptIn: true });
    const s = await campaignSecurity(db, campA);
    expect(s!.readiness).toMatchObject({ ok: true, spyAccounts: 1, adminNumbers: 1 });
    expect(s!.config.enabled).toBe(true);
    expect(s!.antiSpamOptIn).toBe(true);
  });

  it('handler real: incidente único, autor nas listas anti-hacker e anti-spam', async () => {
    const repo = new DrizzleSecRepo(db);
    const { engine, calls } = setup();
    const w = messageWebhook(HACKER, 'oi');
    await onMessage(ev<'message.in'>(w), { repo, engine });
    await onMessage(ev<'message.in'>({ ...w, session: 'spy1' }), { repo, engine });
    expect(calls.map((c) => c.op)).toEqual(['deleteMessage', 'removeParticipants']);
    const { rows } = await listIncidents(db, { campaignId: campA });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'message', status: 'acted', phone: `+${HACKER}`, groupName: 'Camp A #1' });
    expect(rows[0]!.actions.every((a) => a.ok)).toBe(true);
  });

  it('shouldRejectJoin: bloqueia em A (lista própria) e só nas campanhas com opt-in do anti-spam', async () => {
    expect((await shouldRejectJoin(db, `${HACKER}@c.us`, campA)).reject).toBe(true);
    expect((await shouldRejectJoin(db, `${HACKER}@c.us`, campB)).reject).toBe(false);
    await setAntiSpamOptIn(db, campB, true);
    expect((await shouldRejectJoin(db, HACKER, campB)).reject).toBe(true);
    await setAntiSpamOptIn(db, campB, false);
    await setAntiSpamOptIn(db, campA, false);
    // sem opt-in a lista compartilhada fica desativada (campaign_ids vazio valeria p/ todas)
    const [l] = await sql`select disabled, campaign_ids from mag.blacklists where name = ${ANTI_SPAM_LIST_NAME}`;
    expect(l).toMatchObject({ disabled: true, campaign_ids: [] });
    expect((await shouldRejectJoin(db, HACKER, campB)).reject).toBe(false);
    expect((await isBlocked(db, HACKER, { campaignId: campA })).blocked).toBe(true); // lista anti-hacker da A
    expect((await shouldRejectJoin(db, '5511999990003', campA)).reject).toBe(false); // admin nunca
  });

  it('colaboradores: cadastro, CSV, consulta com histórico e contadores; entra na allowlist', async () => {
    await addCollaborator(db, campA, { value: '(11) 99999-0011', name: 'Suporte' });
    expect(await importCollaborators(db, campA, [{ number: '+5511999990020', name: 'Vendas' }, { lid: '100000000000004' }]))
      .toEqual({ inserted: 2, skipped: 0 });
    expect((await verifyNumber(db, campA, '11999990011', { channel: 'publico' })).match).toMatchObject({
      kind: 'collaborator',
      name: 'Suporte',
    });
    expect((await verifyNumber(db, campA, '5511999990001')).match).toMatchObject({ kind: 'account', name: 'Principal' });
    expect((await verifyNumber(db, campA, '11 99999-0018')).result).toBe(false);
    expect((await verifyNumber(db, campA, 'abc')).valid).toBe(false);
    const h = await verificationHistory(db, campA);
    expect(h).toHaveLength(4);
    const c = await verificationCounts(db, campA);
    expect(c).toMatchObject({ total: 4, positives: 2 });
    const trusted = await new DrizzleSecRepo(db).trusted(campA);
    expect(trusted.map((t) => t.number ?? t.lid)).toEqual(
      expect.arrayContaining(['+5511999990003', '+5511999990011', '100000000000004']),
    );
  });

  // wa_accounts.lid e group_participants.lid guardam o valor do engine COM `@lid`; a identidade tem que sair igual
  it('chip nosso com lid gravado com sufixo: agencyAccounts, accountsInGroup e verifyNumber o reconhecem', async () => {
    const LID = '100000000000001@lid';
    const [chip] = await db
      .insert(waAccounts)
      .values({ name: 'Chip LID', sessionName: 'lid1', lid: LID, status: 'active' })
      .returning();
    await db.update(campaigns).set({ accountIds: [chip!.id] }).where(eq(campaigns.id, campB));
    const [g] = await db.select().from(groups).where(eq(groups.gid, GID));
    await db.insert(groupParticipants).values({ groupId: g!.id, phone: LID, lid: LID });
    const repo = new DrizzleSecRepo(db);
    expect((await repo.agencyAccounts()).map((i) => i.lid)).toContain('100000000000001');
    const ctx = await repo.groupContext(GID, { associatedOnly: false });
    expect(ctx!.accounts.find((a) => a.sessionName === 'lid1')).toMatchObject({ associated: false });
    expect((await verifyNumber(db, campB, LID)).match).toMatchObject({ kind: 'account', name: 'Chip LID' });
  });

  it('incidentes: filtro, ignorar, relatório por número e CSV', async () => {
    const { rows } = await listIncidents(db, { kind: 'message' });
    await resolveIncidents(db, [rows[0]!.id], 'ignored');
    expect((await listIncidents(db, { open: true })).total).toBe(0);
    expect(await incidentsByNumber(db)).toEqual([expect.objectContaining({ key: `+${HACKER}`, total: 1 })]);
    const csv = incidentsCsv((await listIncidents(db)).rows);
    expect(csv.split('\r\n')[0]).toBe('﻿Data;Tipo;Status;Número;LID;Autor;Campanha;Grupo;Ações');
    expect(csv).toContain('Mensagem de não-admin;Ignorado');
  });

  it('reação grava incidente kind=reaction no banco (CHECK da tabela) e apaga a mensagem no motor', async () => {
    await saveAntiHacker(db, campA, { enabled: true, reactionProtection: true });
    const repo = new DrizzleSecRepo(db);
    const { engine, calls } = setup();
    // membro comum reagindo não age; número administrativo (cadastrado acima) sim
    await onReaction(ev<'message.reaction'>(reactionWebhook('5511999990014', '5511999990016', 'PGREACT1')), {
      repo,
      engine,
    });
    expect(calls).toHaveLength(0);
    const w = reactionWebhook('5511999990003', '5511999990016', 'PGREACT1');
    await onReaction(ev<'message.reaction'>(w), { repo, engine });
    expect(calls[0]!.op).toBe('deleteMessage');
    const { rows } = await listIncidents(db, { kind: 'reaction' });
    expect(rows).toHaveLength(1);
    // 1 CHECK de kind, superset da lista da varredura
    const ck = await sql`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
      WHERE conrelid = 'mag.security_incidents'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~* 'kind'`;
    expect(ck).toHaveLength(1);
    for (const k of ['message', 'promote', 'admin_lost', 'group_update', 'blocked_join', 'audit', 'reaction',
      'scan.blacklisted', 'scan.non-admin-message', 'scan.unknown-admin'])
      expect(ck[0]!.d).toContain(`'${k}'`);
    expect(rows[0]).toMatchObject({ phone: '+5511999990016', status: 'acted' });
  });

  it('página pública /verificar/<slug> responde só equipe/não-equipe, sem expor a lista', async () => {
    const page = await ensureVerifyPage(db, campA);
    expect(page.slug).toMatch(/^[a-z0-9]{10}$/);
    expect((await ensureVerifyPage(db, campA)).slug).toBe(page.slug); // idempotente
    expect(page.enabled).toBe(false); // nasce desligada: só o operador publica
    expect(await publicVerifyPage(db, page.slug)).toBeNull();
    expect(await publicVerify(db, page.slug, '11 99999-0011')).toBeNull();
    await setVerifyPage(db, campA, { enabled: true });
    // sem nome de evento: título neutro, nunca o nome interno da operação
    expect(await publicVerifyPage(db, page.slug)).toEqual({ slug: page.slug, title: PUBLIC_VERIFY_TITLE });
    const yes = await publicVerify(db, page.slug, '11 99999-0011');
    expect(yes).toEqual({ status: 'equipe' });
    expect(await publicVerify(db, page.slug, '11 99999-0019')).toEqual({ status: 'nao-equipe' });
    expect(await publicVerify(db, page.slug, 'xyz')).toEqual({ status: 'invalido' });
    expect(JSON.stringify(yes)).not.toContain('Suporte'); // nome/ids nunca saem
    const h = await verificationHistory(db, campA, { limit: 3 });
    expect(h.map((x) => x.channel)).toEqual(['publico', 'publico', 'publico']);
    await setVerifyPage(db, campA, { enabled: false, eventName: 'Lançamento X' });
    expect(await publicVerifyPage(db, page.slug)).toBeNull();
    expect(await publicVerify(db, page.slug, '11 99999-0011')).toBeNull();
    await setVerifyPage(db, campA, { enabled: true, eventName: 'Lançamento X' });
    expect(await publicVerifyPage(db, page.slug)).toEqual({ slug: page.slug, title: 'Lançamento X' });
    expect(await publicVerifyPage(db, 'naoexiste1')).toBeNull();
  });
});
