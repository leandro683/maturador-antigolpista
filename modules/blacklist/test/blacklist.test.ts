import type { Db } from '@mag/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, PG_URL } from '@mag/db/test-pg';
import { isBlocked, matchBlocked } from '../check';
import { parseBlockCsv } from '../csv';
import { normalizeEntry } from '../normalize';
import {
  addAdminNumber,
  addAutoBlocked,
  addNumber,
  createList,
  deleteList,
  importNumbers,
  listAdminNumbers,
  listLists,
  listNumbers,
  removeAdminNumber,
  removeNumbers,
  updateList,
} from '../service';

describe('normalizeEntry', () => {
  it('telefone BR → E.164 com 9º dígito; LID por sufixo @lid ou tipo explícito', () => {
    expect(normalizeEntry('(11) 99999-0001')).toEqual({ number: '+5511999990001' });
    expect(normalizeEntry('+55 11 3333-0001')).toEqual({ number: '+551133330001' });
    expect(normalizeEntry('5511999990001@c.us')).toEqual({ number: '+5511999990001' });
    expect(normalizeEntry('100000000000001@lid')).toEqual({ lid: '100000000000001' });
    expect(normalizeEntry('100000000000001', 'lid')).toEqual({ lid: '100000000000001' });
    expect(normalizeEntry('abc')).toBeNull();
    expect(normalizeEntry('12', 'lid')).toBeNull();
  });
});

describe('parseBlockCsv', () => {
  it('cabeçalho telefone/lid/nome, separador ; ou ,', () => {
    const r = parseBlockCsv('nome;telefone;lid\nFalsário;(11) 99999-0001;\nSpammer;;100000000000001\n');
    expect(r.entries).toEqual([
      { name: 'Falsário', number: '+5511999990001' },
      { name: 'Spammer', lid: '100000000000001' },
    ]);
    expect(r.errors).toEqual([]);
  });

  it('aceita "phone"/"numero"; ignora linhas vazias; reporta inválidos e duplicados', () => {
    const r = parseBlockCsv('phone,name\n11999990001,A\n\n+5511999990001,B\nxyz,C\n');
    expect(r.entries).toEqual([{ number: '+5511999990001', name: 'A' }]);
    expect(r.duplicates).toBe(1);
    expect(r.errors).toEqual([{ line: 5, value: 'xyz', reason: 'número inválido' }]);
  });

  it('sem cabeçalho: 1 número por linha (LID se @lid)', () => {
    const r = parseBlockCsv('11999990001\r\n100000000000002@lid\r\n');
    expect(r.entries).toEqual([{ number: '+5511999990001' }, { lid: '100000000000002' }]);
  });

  it('campo entre aspas com separador e BOM', () => {
    const r = parseBlockCsv('﻿telefone,nome\n"11999990001","Silva, João"\n');
    expect(r.entries).toEqual([{ number: '+5511999990001', name: 'Silva, João' }]);
  });

  it('cabeçalho sem coluna telefone/lid = erro geral', () => {
    const r = parseBlockCsv('email\nalguem@example.com\n');
    expect(r.entries).toEqual([]);
    expect(r.errors[0]?.reason).toMatch(/coluna/);
  });
});

describe('matchBlocked (pura)', () => {
  const entries = [
    { listId: 'L1', number: '+5511999990001', lid: null, campaignIds: [], disabled: false },
    { listId: 'L2', number: '+5511999990002', lid: null, campaignIds: ['C1'], disabled: false },
    { listId: 'L3', number: null, lid: '555', campaignIds: [], disabled: false },
    { listId: 'L4', number: '+5511999990003', lid: null, campaignIds: [], disabled: true },
  ];
  it('casa variantes do 9º dígito, LID, escopo de campanha e lista desativada', () => {
    expect(matchBlocked(entries, [], { number: '+551199990001' }).listIds).toEqual(['L1']); // sem 9
    expect(matchBlocked(entries, [], { lid: '555' }).blocked).toBe(true);
    expect(matchBlocked(entries, [], { number: '+5511999990002' }, 'C2').blocked).toBe(false);
    expect(matchBlocked(entries, [], { number: '+5511999990002' }, 'C1').blocked).toBe(true);
    expect(matchBlocked(entries, [], { number: '+5511999990003' }).blocked).toBe(false);
  });
  it('número administrativo nunca é bloqueado', () => {
    const r = matchBlocked(entries, [{ number: '+5511999990001', lid: null }], { number: '+5511999990001' });
    expect(r).toEqual({ blocked: false, admin: true, listIds: [] });
  });
});

describe.skipIf(!PG_URL)('service + isBlocked — Postgres real', () => {
  let db: Db;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
  });
  afterAll(async () => drop?.());

  it('listas nomeadas, números manual/csv, busca, remover', async () => {
    const l = await createList(db, { name: 'Falsários' });
    expect((await addNumber(db, l.id, { value: '(11) 99999-0001', name: 'Golpista' })).number).toBe(
      '+5511999990001',
    );
    await expect(addNumber(db, l.id, { value: 'abc' })).rejects.toThrow(/inválido/);
    const csv = parseBlockCsv('telefone;nome\n11999990002;A\n11999990001;dup\n;\n');
    const r = await importNumbers(db, l.id, csv.entries);
    expect(r).toEqual({ inserted: 1, skipped: 1 });
    const all = await listNumbers(db, { blacklistId: l.id });
    expect(all.total).toBe(2);
    expect(all.rows.map((x) => x.source).sort()).toEqual(['csv', 'manual']);
    expect((await listNumbers(db, { blacklistId: l.id, search: '90002' })).rows).toHaveLength(1);
    expect((await listNumbers(db, { blacklistId: l.id, search: 'golp' })).rows).toHaveLength(1);
    await removeNumbers(db, [all.rows[0]!.id]);
    expect((await listNumbers(db, { blacklistId: l.id })).total).toBe(1);
    expect((await listLists(db)).find((x) => x.id === l.id)?.count).toBe(1);
  });

  it('isBlocked: telefone, JID, LID, automático, admin, lista desativada e excluída', async () => {
    const l = await createList(db, { name: 'Spam' });
    await addNumber(db, l.id, { value: '+55 11 99999-0003' });
    await addNumber(db, l.id, { value: '100000000000003', kind: 'lid' });
    expect((await isBlocked(db, '5511999990003@c.us')).blocked).toBe(true);
    expect((await isBlocked(db, '100000000000003@lid')).blocked).toBe(true);
    expect((await isBlocked(db, '+5511999990004')).blocked).toBe(false);

    await addAutoBlocked(db, '5511999990005@c.us', 'Hacker de mensagem 123');
    const auto = await isBlocked(db, '+5511999990005');
    expect(auto.blocked).toBe(true);
    const autoRow = (await listNumbers(db, { search: '90005' })).rows[0];
    expect(autoRow?.source).toBe('anti_hacker');

    await addAdminNumber(db, { value: '11999990003', label: 'Equipe' });
    expect(await isBlocked(db, '+5511999990003')).toMatchObject({ blocked: false, admin: true });
    const [adm] = await listAdminNumbers(db);
    await removeAdminNumber(db, adm!.id);
    expect((await isBlocked(db, '+5511999990003')).blocked).toBe(true);

    await updateList(db, l.id, { disabled: true });
    expect((await isBlocked(db, '+5511999990003')).blocked).toBe(false);
    await updateList(db, l.id, { disabled: false });
    await deleteList(db, l.id);
    expect((await isBlocked(db, '100000000000003@lid')).blocked).toBe(false);
  });

  it('lista restrita a campanhas', async () => {
    const campaignId = '00000000-0000-4000-8000-000000000001';
    const l = await createList(db, { name: 'Só camp', campaignIds: [campaignId] });
    await addNumber(db, l.id, { value: '11999990006' });
    expect((await isBlocked(db, '+5511999990006', { campaignId })).blocked).toBe(true);
    expect(
      (await isBlocked(db, '+5511999990006', { campaignId: '00000000-0000-4000-8000-000000000002' })).blocked,
    ).toBe(false);
    expect((await isBlocked(db, '+5511999990006')).blocked).toBe(false);
  });
});
