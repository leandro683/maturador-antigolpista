import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import type postgres from 'postgres';
import type { Db } from '@mag/db';
import { actions, actionSteps, campaigns, groupParticipants, groups, history, waAccounts } from '@mag/db/schema';
import type { ChatMessage, GroupInfo } from '@mag/wa-engine';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import { addAdminNumber, addNumber, createList } from '../../blacklist/service';
import { lists } from '../../blacklist/tables';
import { ANTI_SPAM_LIST_NAME, saveSecuritySettings, setAntiSpamOptIn } from '../src/antispam';
import { identityOf } from '../src/identity';
import { listIncidents } from '../src/incidents';
import { DrizzleSecRepo } from '../src/repo';
import {
  actOnFindings,
  activeScan,
  listScans,
  ScanAlreadyRunningError,
  scanGroup,
  type ScanStepResult,
  SECURITY_SCAN_TYPE,
  securityScanType,
  startScan,
} from '../src/scan';
import { photoHash } from '../src/photo';
import { readSecuritySettings } from '../src/settings';
import { incidents } from '../src/tables';

/**
 * Análise e interruptores no Postgres real (TEST_DATABASE_URL): tipos de incidente, interruptores globais (+ Histórico + lista
 * compartilhada), contas de fora da campanha no grupo, varredura com grupos falsos, progresso e ações do operador.
 * Nenhuma chamada a WhatsApp real: engine de mentira que só registra.
 */
describe.skipIf(!PG_URL)('análise e interruptores no Postgres', () => {
  let db: Db;
  let sql: postgres.Sql;
  let drop: () => Promise<void>;
  let repo: DrizzleSecRepo;
  const ids = {} as Record<'camp' | 'other' | 'main' | 'spy' | 'out' | 'g1' | 'g2', string>;
  const G1 = '1203630000000002@g.us';
  const G2 = '1203630000000003@g.us';
  const TEAM = '5511999990003';
  const BLOCKED = '5511999990012';
  const ROGUE = '5511999990024';
  const HACKER = '5511999990002';
  const OUT = '5511999990010'; // conta nossa de outra campanha

  beforeAll(async () => {
    ({ db, sql, drop } = await freshDb());
    repo = new DrizzleSecRepo(db);
    const [main] = await db
      .insert(waAccounts)
      .values({ name: 'Principal', sessionName: 'main1', jid: '5511999990001@c.us', status: 'active' })
      .returning();
    const [spy] = await db
      .insert(waAccounts)
      .values({ name: 'Espiã', sessionName: 'spy1', jid: '5511999990004@c.us', status: 'active', rolePolicy: { role: 'spy' } })
      .returning();
    const [out] = await db
      .insert(waAccounts)
      .values({ name: 'Outra', sessionName: 'out1', jid: `${OUT}@c.us`, status: 'active' })
      .returning();
    const [c] = await db
      .insert(campaigns)
      .values({ name: 'Scan', slug: 'scan', accountIds: [main!.id, spy!.id] })
      .returning();
    const [o] = await db.insert(campaigns).values({ name: 'Outra', slug: 'outra', accountIds: [out!.id] }).returning();
    const [g1] = await db
      .insert(groups)
      .values({ campaignId: c!.id, waAccountId: main!.id, name: 'Scan #1', gid: G1, settings: { announce: true } })
      .returning();
    const [g2] = await db
      .insert(groups)
      .values({ campaignId: c!.id, waAccountId: main!.id, name: 'Scan #2', gid: G2, settings: { announce: false } })
      .returning();
    Object.assign(ids, { camp: c!.id, other: o!.id, main: main!.id, spy: spy!.id, out: out!.id, g1: g1!.id, g2: g2!.id });
    await addAdminNumber(db, { value: TEAM, label: 'Equipe' });
    const bl = await createList(db, { name: 'Golpistas', campaignIds: [c!.id] });
    await addNumber(db, bl.id, { value: BLOCKED, name: 'golpista' });
    await db.insert(groupParticipants).values({ groupId: g1!.id, phone: `+${OUT}`, isAdmin: false });
  });
  afterAll(async () => drop?.());

  it('aceita os tipos scan.* e o status open; recusa tipo desconhecido', async () => {
    const base = { campaignId: ids.camp, groupId: ids.g1, gid: G1, severity: 'warning' as const };
    await db.insert(incidents).values({ ...base, kind: 'scan.unknown-admin', status: 'open', dedupKey: 'mig:1' });
    await expect(
      sql`INSERT INTO mag.security_incidents (kind, dedup_key) VALUES ('scan.qualquer', 'mig:2')`,
    ).rejects.toThrow(/check/i);
    await expect(
      sql`INSERT INTO mag.security_incidents (kind, status, dedup_key) VALUES ('message', 'aberto', 'mig:3')`,
    ).rejects.toThrow(/check/i);
  });

  it('aceita o tipo scan.impersonator com status open', async () => {
    const base = { campaignId: ids.camp, groupId: ids.g1, gid: G1, severity: 'warning' as const };
    await db.insert(incidents).values({ ...base, kind: 'scan.impersonator', status: 'open', dedupKey: 'mig:imp' });
    const { rows } = await listIncidents(db, { kind: 'scan.impersonator', open: true });
    expect(rows).toHaveLength(1);
    // 1 CHECK de kind e os 2 índices parciais
    const ck = await sql`SELECT 1 FROM pg_constraint WHERE conrelid = 'mag.security_incidents'::regclass
      AND contype = 'c' AND pg_get_constraintdef(oid) ~* 'kind'`;
    expect(ck).toHaveLength(1);
    const ix = await sql`SELECT indexdef FROM pg_indexes WHERE schemaname = 'mag' AND indexname LIKE 'security_incidents_scan%'`;
    expect(ix).toHaveLength(2);
    // o predicado dos 2 índices parciais acompanha SCAN_KINDS (senão o planner não os usa p/ o tipo novo)
    for (const r of ix) expect(r.indexdef).toContain('scan.impersonator');
  });

  it('padrões, salvar registra no Histórico e a lista compartilhada passa a valer p/ todas', async () => {
    expect(await repo.globalSettings()).toEqual({ antiSpamAssociatedOnly: true, sharedBlocklistAllCampaigns: false });
    await setAntiSpamOptIn(db, ids.camp, true);
    const shared = async () => (await db.select().from(lists).where(eq(lists.name, ANTI_SPAM_LIST_NAME)))[0]!;
    expect((await shared()).campaignIds).toEqual([ids.camp]);

    const after = await saveSecuritySettings(db, { sharedBlocklistAllCampaigns: true }, null, '10.0.0.1');
    expect(after.sharedBlocklistAllCampaigns).toBe(true);
    expect(await shared()).toMatchObject({ campaignIds: [], disabled: false });
    const h = await db.select().from(history).where(eq(history.type, 'security.settings.update'));
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({
      location: 'seguranca',
      entityIds: ['global'],
      before: { sharedBlocklistAllCampaigns: false },
      after: { sharedBlocklistAllCampaigns: true },
      ip: '10.0.0.1',
    });
    // opt-in de outra campanha com o global ligado: continua valendo p/ todas
    await setAntiSpamOptIn(db, ids.other, true);
    expect((await shared()).campaignIds).toEqual([]);

    await saveSecuritySettings(db, { sharedBlocklistAllCampaigns: false });
    expect((await shared()).campaignIds.sort()).toEqual([ids.camp, ids.other].sort());
    // salvar sem mudança não polui o Histórico
    await saveSecuritySettings(db, { sharedBlocklistAllCampaigns: false });
    expect(await db.select().from(history).where(eq(history.type, 'security.settings.update'))).toHaveLength(2);
    expect((await readSecuritySettings(db)).updatedAt).toBeInstanceOf(Date);
  });

  it('com "só associadas" desligado, a conta de fora presente no grupo entra no contexto', async () => {
    const on = await repo.groupContext(G1);
    expect(on!.accounts.map((a) => a.sessionName).sort()).toEqual(['main1', 'spy1']);
    const off = await repo.groupContext(G1, { associatedOnly: false });
    expect(off!.accounts.find((a) => a.sessionName === 'out1')).toMatchObject({ associated: false, id: ids.out });
    // não está no G2 → não entra
    expect((await repo.groupContext(G2, { associatedOnly: false }))!.accounts).toHaveLength(2);
  });

  it('chip de consulta de fora da campanha entra no contexto marcado `lookup`, mesmo com "só associadas" ligado', async () => {
    const [before] = await db.select({ ah: campaigns.antiHacker }).from(campaigns).where(eq(campaigns.id, ids.camp));
    await db
      .update(campaigns)
      .set({ antiHacker: { ...(before!.ah as object), impersonationLookupAccountIds: [ids.out] } })
      .where(eq(campaigns.id, ids.camp));
    try {
      const c = await new DrizzleSecRepo(db).groupContext(G2); // repo novo: sem cache de contas
      expect(c!.accounts.find((a) => a.id === ids.out)).toMatchObject({ sessionName: 'out1', associated: false, lookup: true });
      expect(c!.accounts.filter((a) => a.associated).map((a) => a.sessionName).sort()).toEqual(['main1', 'spy1']);
    } finally {
      await db.update(campaigns).set({ antiHacker: before!.ah }).where(eq(campaigns.id, ids.camp));
    }
  });

  const info = (gid: string, announce: boolean): GroupInfo => ({
    gid,
    subject: 'x',
    announce,
    participants: [
      { jid: '5511999990001@c.us', isAdmin: true, isSuperAdmin: true },
      { jid: `${TEAM}@c.us`, isAdmin: true, isSuperAdmin: false },
      { jid: `${OUT}@c.us`, isAdmin: true, isSuperAdmin: false }, // conta nossa → nunca achado
      { jid: `${ROGUE}@c.us`, isAdmin: true, isSuperAdmin: false },
      { jid: `${BLOCKED}@c.us`, isAdmin: false, isSuperAdmin: false },
    ],
  });
  const msgs: ChatMessage[] = [
    { id: 'false_G1_A_team', from: `${TEAM}@c.us`, fromMe: false, body: 'aviso', hasMedia: false, ts: 1 },
    { id: 'false_G1_H_hacker', from: `${HACKER}@c.us`, fromMe: false, body: 'pix aqui', hasMedia: false, ts: 2 },
  ];
  const scanEngine = {
    getGroup: async (_s: string, gid: string) => info(gid, gid === G1),
    listMessages: async () => msgs,
  };

  let scanId: string;

  it('progresso e "1 análise por campanha"; startScan grava no Histórico', async () => {
    const [parent] = await db
      .insert(actions)
      .values({
        type: SECURITY_SCAN_TYPE,
        campaignId: ids.camp,
        payload: { messageLimit: 30 },
        status: 'processing',
        total: 2,
        processed: 1,
      })
      .returning();
    scanId = parent!.id;
    const [child] = await db
      .insert(actions)
      .values({ type: SECURITY_SCAN_TYPE, parentId: scanId, campaignId: ids.camp, waAccountId: ids.main, status: 'processing' })
      .returning();
    await db.insert(actionSteps).values([
      { actionId: child!.id, groupId: ids.g1, target: G1, status: 'success', result: { findings: 3, profilesSkipped: 2 } },
      {
        actionId: child!.id,
        groupId: ids.g2,
        target: G2,
        status: 'success',
        result: { findings: 0, profilesSkipped: 1, messagesUnavailable: 'busca de mensagens falhou: WAHA 501' },
      },
    ]);
    expect(await activeScan(db, ids.camp)).toBe(scanId);
    const created: unknown[] = [];
    await expect(
      startScan(db, async (i) => (created.push(i), { id: 'x' }), ids.camp, { messageLimit: 10 }),
    ).rejects.toBeInstanceOf(ScanAlreadyRunningError);
    expect(created).toEqual([]);
    const newId = await startScan(
      db,
      async (i) => {
        created.push(i);
        const [a] = await db
          .insert(actions)
          .values({ type: i.type, campaignId: i.campaignId, payload: i.payload, status: 'success' })
          .returning();
        return a!;
      },
      ids.other,
      { messageLimit: 10 },
    );
    expect(created).toEqual([
      {
        type: SECURITY_SCAN_TYPE,
        campaignId: ids.other,
        payload: { messageLimit: 10, checkProfiles: false, autoAct: false },
        options: { targets: { mode: 'all' }, accounts: { from: 'campaign' } },
      },
    ]);
    const h = await db.select().from(history).where(eq(history.type, 'security.scan.start'));
    expect(h.map((x) => x.entityIds[0])).toEqual([newId]);
  });

  it('varredura dos grupos falsos grava achados em aberto (sem agir) e aparece no progresso', async () => {
    const step = (gid: string, groupId: string) => ({
      session: 'main1',
      gid,
      groupId,
      payload: { messageLimit: 30 },
      index: 0,
      actionId: scanId,
      accountId: ids.main,
    });
    const r1 = await scanGroup({ repo }, scanEngine, step(G1, ids.g1));
    expect(r1).toMatchObject({ blacklisted: 1, unknownAdmins: 1, nonAdminMessages: 1, messages: 2, closed: true });
    const r2 = await scanGroup({ repo }, scanEngine, step(G2, ids.g2));
    expect(r2).toMatchObject({ blacklisted: 1, unknownAdmins: 1, nonAdminMessages: 0, messages: null, closed: false });
    // repetir não duplica achado aberto
    expect((await scanGroup({ repo }, scanEngine, step(G1, ids.g1))).findings).toBe(0);

    const { rows, total } = await listIncidents(db, { scanId, open: true });
    expect(total).toBe(5);
    expect(rows.every((r) => r.status === 'open' && r.waAccountId === ids.main)).toBe(true);
    const [view] = await listScans(db, { campaignId: ids.camp });
    expect(view).toMatchObject({
      id: scanId,
      status: 'processing',
      total: 2,
      processed: 1,
      findings: 5,
      open: 5,
      messagesUnavailable: 1,
      profilesSkipped: 3,
      messageLimit: 30,
      active: true,
    });
  });

  const recorder = (fail: string[] = []) => {
    const calls: { op: string; session: string; gid: string; arg: unknown }[] = [];
    return {
      calls,
      engine: {
        // só achado de impostor consulta o grupo; os outros testes não esperam essa chamada
        getGroup: async (): Promise<GroupInfo> => {
          throw new Error('getGroup não esperado');
        },
        removeParticipants: async (session: string, gid: string, jids: string[]) => {
          calls.push({ op: 'remove', session, gid, arg: jids });
          return jids.map((jid) => (fail.includes(jid) ? { jid, ok: false, error: 'not-admin' } : { jid, ok: true }));
        },
        deleteMessage: async (session: string, gid: string, id: string) => {
          calls.push({ op: 'delete', session, gid, arg: id });
          if (fail.includes(id)) throw new Error('WAHA 500');
        },
      },
    };
  };
  const findings = async (kind: string, gid?: string) =>
    (await listIncidents(db, { scanId, kind: kind as never })).rows.filter((r) => !gid || r.gid === gid);

  it('operador: Apagar mensagem pela conta dona do grupo; registra a ação e resolve', async () => {
    const [m] = await findings('scan.non-admin-message');
    const { engine, calls } = recorder();
    const r = await actOnFindings({ db, engine, gapMs: 0 }, [m!.id], 'delete', null);
    expect(r).toMatchObject({ done: 1, failed: 0 });
    expect(calls).toEqual([{ op: 'delete', session: 'main1', gid: G1, arg: 'false_G1_H_hacker' }]);
    const [row] = await db.select().from(incidents).where(eq(incidents.id, m!.id));
    expect(row).toMatchObject({ status: 'acted' });
    expect(row!.resolvedAt).toBeInstanceOf(Date);
    expect(row!.actions).toEqual([{ type: 'apagar-mensagem', target: 'false_G1_H_hacker (conta main1)', ok: true }]);
    // de novo: já resolvido → nada
    expect(await actOnFindings({ db, engine, gapMs: 0 }, [m!.id], 'delete')).toMatchObject({ done: 0, skipped: 1 });
  });

  it('operador: Remover participante em lote (1 chamada por grupo); falha fica em aberto como "failed"', async () => {
    const rows = [...(await findings('scan.blacklisted')), ...(await findings('scan.unknown-admin'))];
    expect(rows).toHaveLength(4);
    const { engine, calls } = recorder([`${ROGUE}@c.us`]);
    const sleeps: number[] = [];
    const r = await actOnFindings(
      { db, engine, gapMs: 1500, sleep: async (ms) => void sleeps.push(ms) },
      rows.map((x) => x.id),
      'remove',
    );
    expect(r).toMatchObject({ done: 2, failed: 2 });
    expect(calls.map((c) => [c.op, c.session, c.gid, (c.arg as string[]).sort()])).toEqual([
      ['remove', 'main1', G1, [`${BLOCKED}@c.us`, `${ROGUE}@c.us`].sort()],
      ['remove', 'main1', G2, [`${BLOCKED}@c.us`, `${ROGUE}@c.us`].sort()],
    ]);
    expect(sleeps).toEqual([1500]); // pausa anti-ban entre as chamadas
    const after = await listIncidents(db, { scanId, kind: 'scan.unknown-admin' });
    expect(after.rows.every((x) => x.status === 'failed' && !x.resolvedAt)).toBe(true);
    expect(after.rows[0]!.actions[0]).toMatchObject({ type: 'remover-participante', ok: false, error: 'not-admin' });
    expect((await listIncidents(db, { scanId, kind: 'scan.blacklisted' })).rows.every((x) => x.status === 'acted')).toBe(
      true,
    );
    const h = await db.select().from(history).where(eq(history.type, 'security.finding.remove'));
    expect(h[0]!.after).toEqual({ done: 2, failed: 2, skipped: 0 });
  });

  it('operador: quem virou número administrativo depois da análise não é removido; Ignorar resolve', async () => {
    await addAdminNumber(db, { value: ROGUE, label: 'Agora é equipe' });
    const rows = await findings('scan.unknown-admin');
    const { engine, calls } = recorder();
    const r = await actOnFindings({ db, engine, gapMs: 0 }, rows.map((x) => x.id), 'remove');
    expect(r.done).toBe(0);
    expect(r.skipped).toBe(2);
    expect(r.notes[0]).toMatch(/lista de confiança/);
    expect(calls).toEqual([]);

    const ig = await actOnFindings({ db }, rows.map((x) => x.id), 'ignore', null);
    expect(ig.done).toBe(2);
    const left = await db
      .select()
      .from(incidents)
      .where(and(eq(incidents.kind, 'scan.unknown-admin'), eq(incidents.status, 'ignored')));
    expect(left).toHaveLength(2);
    // sem engine configurado só "Ignorar" funciona
    await expect(actOnFindings({ db }, ['00000000-0000-4000-8000-000000000000'], 'remove')).rejects.toThrow(
      /WhatsApp não configurado/,
    );
  });

  it('nova análise: ignorado não volta; removido que voltou ao grupo vira achado novo; LID casa com telefone', async () => {
    await db.update(waAccounts).set({ jid: null }).where(eq(waAccounts.id, ids.out)); // sem efeito no allow do G1
    const step = { session: 'main1', gid: G1, groupId: ids.g1, payload: { messageLimit: 0 }, index: 0, actionId: 'scan-b', accountId: ids.main };
    const r = await scanGroup({ repo: new DrizzleSecRepo(db) }, scanEngine, step);
    // ROGUE agora é número administrativo; BLOCKED foi removido (acted) e "voltou" → novo achado
    expect(r).toMatchObject({ blacklisted: 1, unknownAdmins: 1 });
    // a conta OUT perdeu o jid → aparece como admin desconhecido; a mesma pessoa vista só pelo LID não duplica
    const lidOnly = {
      getGroup: async () => ({
        gid: G1,
        subject: 'x',
        announce: true,
        participants: [{ jid: `${OUT}@c.us`, lid: '100000000000007@lid', isAdmin: true, isSuperAdmin: false }],
      }),
    };
    expect((await scanGroup({ repo: new DrizzleSecRepo(db) }, lidOnly, { ...step, actionId: 'scan-c' })).findings).toBe(0);
    const ignoredBack = await listIncidents(db, { kind: 'scan.unknown-admin', open: true });
    expect(ignoredBack.rows.filter((x) => x.phone === `+${ROGUE}`)).toEqual([]);
  });

  it('limites: até 20 por clique; mensagens por grupo entre 0 e 200 (mensagem em português)', async () => {
    const many = Array.from({ length: 25 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const r = await actOnFindings({ db }, many, 'ignore');
    expect(r.skipped).toBe(25);
    expect(r.notes[0]).toMatch(/No máximo 20/);
    await expect(startScan(db, async () => ({ id: 'x' }), ids.other, { messageLimit: 500 })).rejects.toThrow(
      /entre 0 e 200/,
    );
  });

  describe('operador: Remover achado scan.impersonator (admin é intocável)', () => {
    const P_ADMIN = '5511999990011'; // virou admin depois do achado
    const P_PLAIN = '5511999990020'; // continua participante comum
    const L_ADMIN = '555000111'; // só LID, virou super admin
    const seed = async (tag: string) => {
      const mk = (who: { phone?: string; lid?: string }, key: string) => ({
        kind: 'scan.impersonator' as const,
        severity: 'critical' as const,
        status: 'open' as const,
        dedupKey: `imp:${tag}:${key}`,
        campaignId: ids.camp,
        groupId: ids.g2,
        gid: G2,
        waAccountId: ids.main,
        phone: who.phone ? `+${who.phone}` : null,
        lid: who.lid ?? null,
        details: { scanId: `imp-${tag}`, reason: 'photo' },
      });
      const rows = await db
        .insert(incidents)
        .values([mk({ phone: P_ADMIN }, 'a'), mk({ phone: P_PLAIN }, 'b'), mk({ lid: L_ADMIN }, 'c')])
        .returning();
      return rows.map((r) => r.id);
    };
    const group = (): GroupInfo => ({
      gid: G2,
      subject: 'x',
      participants: [
        { jid: `${P_ADMIN}@c.us`, isAdmin: true, isSuperAdmin: false },
        { jid: `${P_PLAIN}@c.us`, isAdmin: false, isSuperAdmin: false },
        { jid: `${L_ADMIN}@lid`, isAdmin: false, isSuperAdmin: true },
      ],
    });
    const eng = (getGroup: () => Promise<GroupInfo>, phoneOfLid?: (s: string, lid: string) => Promise<string | null>) => {
      const r = recorder();
      return { ...r, engine: { ...r.engine, getGroup, ...(phoneOfLid ? { phoneOfLid } : {}) } };
    };
    const one = async (tag: string, who: { phone?: string; lid?: string }) => {
      const [row] = await db
        .insert(incidents)
        .values({
          kind: 'scan.impersonator',
          severity: 'critical',
          status: 'open',
          dedupKey: `imp:${tag}`,
          campaignId: ids.camp,
          groupId: ids.g2,
          gid: G2,
          waAccountId: ids.main,
          phone: who.phone ? `+${who.phone}` : null,
          lid: who.lid ?? null,
          details: { scanId: `imp-${tag}`, reason: 'photo' },
        })
        .returning();
      return row!.id;
    };

    it('quem virou admin (telefone ou só LID) não é removido; o comum é; getGroup roda 1x por pessoa', async () => {
      const ids3 = await seed('ok');
      let asked = 0;
      const { engine, calls } = eng(async () => (asked++, group()));
      const r = await actOnFindings({ db, engine, gapMs: 0 }, ids3, 'remove');
      expect(asked).toBe(3);
      expect(calls).toEqual([{ op: 'remove', session: 'main1', gid: G2, arg: [`${P_PLAIN}@c.us`] }]);
      expect(r).toMatchObject({ done: 1, failed: 0, skipped: 2 });
      expect(r.notes.join(' ')).toMatch(/é admin do grupo — não removido/);
      const rows = await db.select().from(incidents).where(inArray(incidents.id, ids3));
      const byPhone = (phone: string) => rows.find((x) => x.phone === phone)!;
      expect(byPhone(`+${P_PLAIN}`)).toMatchObject({ status: 'acted' });
      expect(byPhone(`+${P_ADMIN}`)).toMatchObject({ status: 'failed', resolvedAt: null });
      expect(byPhone(`+${P_ADMIN}`).actions[0]).toMatchObject({ ok: false, error: 'é admin do grupo — não removido' });
      expect(rows.find((x) => x.lid === L_ADMIN)).toMatchObject({ status: 'failed', resolvedAt: null });
    });

    it('getGroup falhou: nenhum scan.impersonator do grupo é removido', async () => {
      const ids3 = await seed('fail');
      const { engine, calls } = eng(async () => {
        throw new Error('WAHA 500');
      });
      const r = await actOnFindings({ db, engine, gapMs: 0 }, ids3, 'remove');
      expect(calls).toEqual([]);
      expect(r).toMatchObject({ done: 0, skipped: 3 });
      const rows = await db.select().from(incidents).where(inArray(incidents.id, ids3));
      expect(rows.every((x) => x.status === 'failed' && !x.resolvedAt)).toBe(true);
      expect(rows[0]!.actions[0]).toMatchObject({ ok: false, error: 'não foi possível conferir o grupo — não removido' });
    });

    it('entrou na lista oficial depois do achado (participante aparece com telefone e LID): não remove', async () => {
      const OFFICIAL = '5511999990025';
      await addAdminNumber(db, { value: OFFICIAL, label: 'Oficial' });
      const id = await one('official-lid', { lid: '100000000000008' });
      const { engine, calls } = eng(async () => ({
        gid: G2,
        subject: 'x',
        participants: [{ jid: `${OFFICIAL}@c.us`, lid: '100000000000008@lid', isAdmin: false, isSuperAdmin: false }],
      }));
      const r = await actOnFindings({ db, engine, gapMs: 0 }, [id], 'remove');
      expect(calls).toEqual([]);
      expect(r).toMatchObject({ done: 0, skipped: 1 });
      expect(r.notes.join(' ')).toMatch(/está na lista oficial — não removido/);
      const [row] = await db.select().from(incidents).where(eq(incidents.id, id));
      expect(row).toMatchObject({ status: 'failed', resolvedAt: null });
    });

    it('só LID no grupo: phoneOfLid resolve para número oficial -> não remove; para estranho -> remove; ausente -> não remove', async () => {
      const OFFICIAL2 = '5511999990026';
      await addAdminNumber(db, { value: OFFICIAL2, label: 'Oficial 2' });
      const lidGroup = (lid: string) => async (): Promise<GroupInfo> => ({
        gid: G2,
        subject: 'x',
        participants: [{ jid: `${lid}@lid`, isAdmin: false, isSuperAdmin: false }],
      });
      const a = await one('lid-official', { lid: '901000111' });
      const ra = eng(lidGroup('901000111'), async () => `${OFFICIAL2}@c.us`);
      const resA = await actOnFindings({ db, engine: ra.engine, gapMs: 0 }, [a], 'remove');
      expect(resA).toMatchObject({ done: 0, skipped: 1 });
      expect(resA.notes.join(' ')).toMatch(/está na lista oficial — não removido/);
      expect(ra.calls).toEqual([]);

      const b = await one('lid-absent', { lid: '902000111' });
      const rb = eng(lidGroup('902000111'));
      const resB = await actOnFindings({ db, engine: rb.engine, gapMs: 0 }, [b], 'remove');
      expect(rb.calls).toEqual([]);
      expect(resB).toMatchObject({ done: 0, skipped: 1 });
      expect(resB.notes.join(' ')).toMatch(/sem telefone para conferir a lista oficial — não removido/);

      const c = await one('lid-stranger', { lid: '100000000000009' });
      const rc = eng(lidGroup('100000000000009'), async () => '5511999990027@c.us');
      expect(await actOnFindings({ db, engine: rc.engine, gapMs: 0 }, [c], 'remove')).toMatchObject({ done: 1, failed: 0 });
      expect(rc.calls).toEqual([{ op: 'remove', session: 'main1', gid: G2, arg: ['100000000000009@lid'] }]);
    });

    it('pausa entre as conferências: 1 por pessoa antes de remover', async () => {
      const x = await one('pace-x', { phone: '5511999990028' });
      const y = await one('pace-y', { phone: '5511999990029' });
      const { engine } = eng(async () => ({
        gid: G2,
        subject: 'x',
        participants: [
          { jid: '5511999990028@c.us', isAdmin: false, isSuperAdmin: false },
          { jid: '5511999990029@c.us', isAdmin: false, isSuperAdmin: false },
        ],
      }));
      const sleeps: number[] = [];
      const r = await actOnFindings({ db, engine, gapMs: 700, sleep: async (ms) => void sleeps.push(ms) }, [x, y], 'remove');
      expect(r).toMatchObject({ done: 2 });
      expect(sleeps).toEqual([700, 700]); // getGroup(x) | getGroup(y) + removeParticipants
    });

    it('fora da lista do getGroup (não confirmado): não remove, nota e incidente failed', async () => {
      const ids3 = await seed('miss');
      // só o comum consta; o admin e o LID sumiram da lista → sem confirmação positiva, ninguém além do comum sai
      const { engine, calls } = eng(async () => ({
        ...group(),
        participants: group().participants.filter((p) => p.jid.startsWith(P_PLAIN)),
      }));
      const r = await actOnFindings({ db, engine, gapMs: 0 }, ids3, 'remove');
      expect(calls).toEqual([{ op: 'remove', session: 'main1', gid: G2, arg: [`${P_PLAIN}@c.us`] }]);
      expect(r).toMatchObject({ done: 1, failed: 0, skipped: 2 });
      expect(r.notes.join(' ')).toMatch(/não confirmado na lista do grupo — não removido/);
      const rows = await db.select().from(incidents).where(inArray(incidents.id, ids3));
      expect(rows.find((x) => x.phone === `+${P_ADMIN}`)).toMatchObject({ status: 'failed', resolvedAt: null });
      expect(rows.find((x) => x.lid === L_ADMIN)!.actions[0]).toMatchObject({
        ok: false,
        error: 'não confirmado na lista do grupo — não removido',
      });
    });

    it('participante com telefone e LID (lid já com @lid): casa pelo LID do achado', async () => {
      const [row] = await db
        .insert(incidents)
        .values({
          kind: 'scan.impersonator',
          severity: 'critical',
          status: 'open',
          dedupKey: 'imp:lid-only',
          campaignId: ids.camp,
          groupId: ids.g2,
          gid: G2,
          waAccountId: ids.main,
          lid: '100000000000010',
          details: { scanId: 'imp-lid-only', reason: 'photo' },
        })
        .returning();
      // achado só com LID; no grupo ele aparece com telefone + LID e é admin → não pode sair
      const { engine, calls } = eng(async () => ({
        gid: G2,
        subject: 'x',
        participants: [{ jid: '5511999990030@c.us', lid: '100000000000010@lid', isAdmin: true, isSuperAdmin: false }],
      }));
      const r = await actOnFindings({ db, engine, gapMs: 0 }, [row!.id], 'remove');
      expect(calls).toEqual([]);
      expect(r).toMatchObject({ done: 0, skipped: 1 });
    });

    it('pessoa recusada pela trava não sai por outra linha: bloqueado + impostor juntos, agora admin -> nada removido', async () => {
      const mk = (kind: 'scan.blacklisted' | 'scan.impersonator', key: string) => ({
        kind,
        severity: 'critical' as const,
        status: 'open' as const,
        dedupKey: `imp:sib:${key}`,
        campaignId: ids.camp,
        groupId: ids.g2,
        gid: G2,
        waAccountId: ids.main,
        phone: `+${P_ADMIN}`,
        lid: null,
        details: { scanId: 'imp-sib', reason: 'photo' },
      });
      // o bloqueado vem primeiro: a recusa do impostor tem que valer para ele também
      const rows = await db
        .insert(incidents)
        .values([mk('scan.blacklisted', 'bl'), mk('scan.impersonator', 'imp')])
        .returning();
      const { engine, calls } = eng(async () => group());
      const r = await actOnFindings({ db, engine, gapMs: 0 }, rows.map((x) => x.id), 'remove');
      expect(calls).toEqual([]);
      expect(r).toMatchObject({ done: 0, skipped: 2 });
      expect(r.notes.join(' ')).toMatch(/é admin do grupo — não removido/);
      const after = await db.select().from(incidents).where(inArray(incidents.id, rows.map((x) => x.id)));
      expect(after.every((x) => x.status === 'failed' && !x.resolvedAt)).toBe(true);
    });

    it('lista de contas do painel indisponível na trava: não remove o impostor', async () => {
      const id = await one('agfail', { phone: P_PLAIN });
      const { engine, calls } = eng(async () => group());
      let n = 0;
      const base = new DrizzleSecRepo(db);
      // 1ª leitura (união do operador) funciona; a da trava falha
      const repo2 = Object.create(base) as DrizzleSecRepo;
      repo2.agencyAccounts = async () => {
        if (n++ === 0) return base.agencyAccounts();
        throw new Error('banco fora');
      };
      const r = await actOnFindings({ db, engine, repo: repo2, gapMs: 0 }, [id], 'remove');
      expect(calls).toEqual([]);
      expect(r.notes.join(' ')).toMatch(/não foi possível conferir as contas do painel — não removido/);
    });

    it('remover e bloquear: removido com sucesso -> bloqueia na lista da campanha e registra a ação', async () => {
      const id = await one('blk-ok', { phone: P_PLAIN });
      const { engine, calls } = eng(async () => group());
      const blocked: unknown[] = [];
      const repo2 = Object.create(new DrizzleSecRepo(db)) as DrizzleSecRepo;
      repo2.block = async (i) => void blocked.push(i);
      const r = await actOnFindings({ db, engine, repo: repo2, gapMs: 0 }, [id], 'remove', null, true);
      expect(calls).toEqual([{ op: 'remove', session: 'main1', gid: G2, arg: [`${P_PLAIN}@c.us`] }]);
      expect(r).toMatchObject({ done: 1, failed: 0 });
      expect(blocked).toHaveLength(1);
      const [row] = await db.select().from(incidents).where(eq(incidents.id, id));
      expect(row!.actions.map((a) => [a.type, a.ok])).toEqual([
        ['remover-participante', true],
        ['bloquear', true],
      ]);
    });

    it('remover e bloquear: trava recusa (admin) -> nada removido e não bloqueia', async () => {
      const id = await one('blk-admin', { phone: P_ADMIN });
      const { engine, calls } = eng(async () => group());
      const blocked: unknown[] = [];
      const repo2 = Object.create(new DrizzleSecRepo(db)) as DrizzleSecRepo;
      repo2.block = async (i) => void blocked.push(i);
      const r = await actOnFindings({ db, engine, repo: repo2, gapMs: 0 }, [id], 'remove', null, true);
      expect(calls).toEqual([]);
      expect(r).toMatchObject({ done: 0, skipped: 1 });
      expect(blocked).toEqual([]);
    });

    it('sem achado de impostor no lote o getGroup nem é chamado', async () => {
      let asked = 0;
      const { engine } = eng(async () => (asked++, group()));
      const [m] = await db
        .insert(incidents)
        .values({
          kind: 'scan.blacklisted',
          severity: 'warning',
          status: 'open',
          dedupKey: 'imp:plain',
          campaignId: ids.camp,
          groupId: ids.g2,
          gid: G2,
          waAccountId: ids.main,
          phone: '+5511999990031',
          details: { scanId: 'imp-plain' },
        })
        .returning();
      expect(await actOnFindings({ db, engine, gapMs: 0 }, [m!.id], 'remove')).toMatchObject({ done: 1 });
      expect(asked).toBe(0);
    });
  });

  describe('análise automática (autoAct): remove e bloqueia pelo mesmo caminho do botão', () => {
    const PIC = 'http://foto/oficial.png';
    const phone = (n: number) => `55119${String(n).padStart(8, '0')}`;
    let seq = 0;
    let photo: Buffer;
    let hash: string;
    beforeAll(async () => {
      photo = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 30, b: 30 } } })
        .png()
        .toBuffer();
      hash = (await photoHash(photo))!;
    });

    /** campanha + grupo próprios (achado aberto igual bloquearia outra rodada); `adminAfterScan` vira admin a partir do 2º getGroup */
    const mk = async (cfg: Record<string, unknown>, people: string[], adminAfterScan: string[] = []) => {
      const n = ++seq;
      const gid = `12036301000000${String(n).padStart(4, '0')}@g.us`;
      const [c] = await db
        .insert(campaigns)
        .values({
          name: `Auto ${n}`,
          slug: `auto-${n}`,
          accountIds: [ids.main],
          antiHacker: { enabled: true, impersonation: 'auto', impersonationPhotos: [{ label: 'Arte', hash }], ...cfg },
        })
        .returning();
      const [g] = await db
        .insert(groups)
        .values({ campaignId: c!.id, waAccountId: ids.main, name: `Auto #${n}`, gid, settings: { announce: false } })
        .returning();
      let asked = 0;
      const removed: string[][] = [];
      const engine = {
        getGroup: async (): Promise<GroupInfo> => {
          const late = asked++ > 0;
          return {
            gid,
            subject: 'x',
            participants: [
              { jid: '5511999990001@c.us', isAdmin: true, isSuperAdmin: true },
              ...people.map((p) => ({ jid: `${p}@c.us`, isAdmin: late && adminAfterScan.includes(p), isSuperAdmin: false })),
            ],
          };
        },
        getProfilePicture: async () => PIC,
        getContactName: async () => null,
        removeParticipants: async (_s: string, _g: string, jids: string[]) => {
          removed.push(jids);
          return jids.map((jid) => ({ jid, ok: true }));
        },
        deleteMessage: async () => {},
      };
      const run = (autoAct: boolean) =>
        securityScanType({ repo, db, loadPhoto: async () => photo, sleep: async () => {} }).runStep(engine as never, {
          session: 'main1',
          gid,
          groupId: g!.id,
          payload: { messageLimit: 0, checkProfiles: true, autoAct },
          index: 0,
          actionId: `auto-${n}`,
          accountId: ids.main,
        } as never).then((o) => (o as { result: ScanStepResult }).result);
      const rows = () => db.select().from(incidents).where(eq(incidents.groupId, g!.id));
      return { c: c!, run, removed, rows };
    };

    it('foto igual: pessoa removida e bloqueada na lista da campanha; achado acted', async () => {
      const P = phone(1);
      const t = await mk({}, [P]);
      const result = await t.run(true);
      expect(result).toMatchObject({ impersonators: 1, autoRemoved: 1, autoFailed: 0 });
      expect(t.removed).toEqual([[`${P}@c.us`]]);
      const [row] = await t.rows();
      expect(row).toMatchObject({ status: 'acted', kind: 'scan.impersonator' });
      expect(await repo.isBlocked(identityOf(P), t.c.id)).toBe(true);
    });

    it('a pessoa é admin no getGroup (trava): não removida, achado failed, não bloqueada', async () => {
      const P = phone(2);
      const t = await mk({}, [P], [P]);
      const result = await t.run(true);
      expect(result).toMatchObject({ impersonators: 1, autoRemoved: 0, autoFailed: 1 });
      expect(t.removed).toEqual([]);
      expect((await t.rows())[0]).toMatchObject({ status: 'failed', resolvedAt: null });
      expect(await repo.isBlocked(identityOf(P), t.c.id)).toBe(false);
    });

    it('autoAct falso: achado fica open e o WhatsApp não é tocado', async () => {
      const t = await mk({}, [phone(3)]);
      const result = await t.run(false);
      expect(result).toMatchObject({ impersonators: 1, autoRemoved: 0, autoFailed: 0 });
      expect(t.removed).toEqual([]);
      expect((await t.rows())[0]).toMatchObject({ status: 'open' });
    });

    it('campanha saiu do modo auto antes da execução: nada age mesmo com autoAct', async () => {
      const t = await mk({ impersonation: 'review' }, [phone(4)]);
      const result = await t.run(true);
      expect(result).toMatchObject({ impersonators: 1, autoRemoved: 0, autoFailed: 0 });
      expect(t.removed).toEqual([]);
      expect((await t.rows())[0]).toMatchObject({ status: 'open' });
    });

    it('25 achados no grupo: todos tratados (lotes de 20)', async () => {
      const people = Array.from({ length: 25 }, (_, i) => phone(100 + i));
      const t = await mk({}, people);
      const result = await t.run(true);
      expect(result).toMatchObject({ impersonators: 25, autoRemoved: 25, autoFailed: 0 });
      expect(t.removed.map((r) => r.length)).toEqual([20, 5]);
      expect((await t.rows()).every((r) => r.status === 'acted')).toBe(true);
    });
  });

  it('blockedAmong segue a regra do isBlocked (variante sem 9º dígito; admin nunca)', async () => {
    const got = await repo.blockedAmong(
      [identityOf('+551199990012'), identityOf(TEAM), identityOf(HACKER)],
      ids.camp,
    );
    expect(got.map((g) => g.number)).toEqual(['+5511999990012']); // normalizado c/ 9º dígito, casou a variante
    expect(await repo.blockedAmong([identityOf(BLOCKED)], ids.other)).toEqual([]); // lista só da campanha Scan
  });
});
