import { describe, expect, it } from 'vitest';
import { FakeEngine } from '../src/fake/index';
import type { WaEvent } from '../src/types';
import { QrCycle, QrCycleExhaustedError, sessionNameFor } from '../src/waha/sessions';

describe('sessions', () => {
  it('sessionNameFor', () => {
    expect(sessionNameFor('3F2A-11aa-bb')).toBe('mag_3f2a11aabb');
    expect(() => sessionNameFor('--')).toThrow();
  });
  it('QrCycle 5 tentativas + reset', () => {
    const q = new QrCycle();
    expect([1, 2, 3, 4, 5].map(() => q.next('s'))).toEqual([1, 2, 3, 4, 5]);
    expect(() => q.next('s')).toThrow(QrCycleExhaustedError);
    q.reset('s');
    expect(q.current('s')).toBe(0);
  });
});

describe('FakeEngine', () => {
  it('getQr devolve um PNG válido (o painel mostra a imagem no modo demo)', async () => {
    const eng = new FakeEngine();
    await eng.createSession('s1');
    const { image } = await eng.getQr('s1');
    const png = Buffer.from(image.replace('data:image/png;base64,', ''), 'base64');
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
  });
  const setup = async () => {
    const eng = new FakeEngine(undefined, { now: () => 1000 });
    const events: WaEvent[] = [];
    eng.onEvent((e) => {
      events.push(e);
    });
    await eng.createSession('s1');
    await eng.startSession('s1');
    await eng.pair('s1');
    return { eng, events };
  };

  it('pareia e emite session.status', async () => {
    const { eng, events } = await setup();
    expect(await eng.getStatus('s1')).toBe('WORKING');
    expect(events.map((e) => (e.kind === 'session.status' ? e.status : ''))).toEqual(['SCAN_QR_CODE', 'WORKING']);
  });

  it('cria grupo, entra participante, emite group.participants', async () => {
    const { eng, events } = await setup();
    const { gid, inviteCode } = await eng.createGroup('s1', { subject: 'T #1', participants: [] });
    expect(inviteCode).toMatch(/^INV/);
    await eng.simulateJoin(gid, '5511999990005@c.us');
    expect(events.at(-1)).toEqual({
      kind: 'group.participants',
      session: 's1',
      gid,
      action: 'add',
      participants: [{ jid: '5511999990005@c.us' }],
      ts: 1000,
    });
    expect((await eng.getGroup('s1', gid)).participants).toHaveLength(2);
  });

  it('listGroups inclui os grupos criados pela sessão e os em que ela entrou por convite', async () => {
    const { eng } = await setup();
    const { gid, inviteCode } = await eng.createGroup('s1', { subject: 'T', participants: [] });
    await eng.createSession('s2');
    await eng.startSession('s2');
    await eng.pair('s2');
    expect((await eng.listGroups('s2'))).toEqual([]);
    await eng.joinGroup('s2', inviteCode);
    expect((await eng.listGroups('s2')).map((g) => g.gid)).toEqual([gid]);
    expect((await eng.listGroups('s1')).map((g) => g.gid)).toEqual([gid]);
    expect(await eng.listGroups('inexistente')).toEqual([]);
  });

  it('approvalMode → join-request; approve adiciona', async () => {
    const { eng, events } = await setup();
    const { gid } = await eng.createGroup('s1', { subject: 'T', participants: [] });
    await eng.setSettings('s1', gid, { approvalMode: true });
    await eng.simulateJoin(gid, '5511999990005@c.us');
    expect(events.at(-1)).toMatchObject({ kind: 'group.join-request', action: 'created' });
    expect(await eng.approveJoinRequests('s1', gid, ['5511999990005@c.us', '5511999990050@c.us'])).toEqual([
      { jid: '5511999990005@c.us', ok: true },
      { jid: '5511999990050@c.us', ok: false, error: 'no-request' },
    ]);
    expect(events.at(-1)).toMatchObject({ kind: 'group.participants', action: 'add' });
  });

  it('send registra mensagens; revoke troca convite', async () => {
    const { eng } = await setup();
    const { gid, inviteCode } = await eng.createGroup('s1', { subject: 'T', participants: [] });
    const { id } = await eng.send('s1', gid, { type: 'text', text: 'oi' }, { mentions: ['all'] });
    expect(eng.sent).toHaveLength(1);
    expect(eng.sent[0]!.id).toBe(id);
    expect(await eng.revokeInviteCode('s1', gid)).not.toBe(inviteCode);
    expect(eng.capabilities().communities).toBe(false);
  });
});

describe('FakeEngine foto e nome de contato', () => {
  it('devolve o semeado, senão null', async () => {
    const e = new FakeEngine();
    e.sessions.set('s', { status: 'WORKING', me: { jid: '5511999990051@c.us', pushName: 'Eu' } });
    e.pictures.set('5511999990008@c.us', 'https://x/a.jpg');
    e.names.set('5511999990008@c.us', 'Zé');
    expect(await e.getProfilePicture('s', '5511999990008@c.us')).toBe('https://x/a.jpg');
    expect(await e.getContactName('s', '5511999990008@c.us')).toBe('Zé');
    expect(await e.getProfilePicture('s', '5511999990009@c.us')).toBeNull();
    expect(await e.getContactName('s', '5511999990009@c.us')).toBeNull();
  });
});
