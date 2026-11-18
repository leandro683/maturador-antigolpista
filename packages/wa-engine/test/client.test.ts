import { describe, expect, it, vi } from 'vitest';
import { WahaClient, WahaHttpError, WaNotSupportedError } from '../src/waha/client';
import { QrCycleExhaustedError } from '../src/waha/sessions';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function mockFetch(responder: (c: Call) => { status?: number; body?: unknown } = () => ({})) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const c: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const r = responder(c);
    const body = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(body, { status: r.status ?? 200 });
  });
  return { fn, calls };
}

const make = (responder?: Parameters<typeof mockFetch>[0], extra = {}) => {
  const m = mockFetch(responder);
  const client = new WahaClient({ baseUrl: 'http://waha:3000/', apiKey: 'k', fetch: m.fn, ...extra });
  return { client, calls: m.calls };
};

describe('WahaClient', () => {
  it('createSession registra webhook com hmac e manda X-Api-Key', async () => {
    const { client, calls } = make(undefined, { webhook: { url: 'https://app/api/wa/events', hmacKey: 's' } });
    await client.createSession('mag_a');
    expect(calls[0]!.url).toBe('http://waha:3000/api/sessions');
    expect(calls[0]!.headers['X-Api-Key']).toBe('k');
    expect(calls[0]!.body).toMatchObject({
      name: 'mag_a',
      start: false,
      config: { webhooks: [{ url: 'https://app/api/wa/events', hmac: { key: 's' } }] },
    });
  });

  it('listSessions (importar sessão existente)', async () => {
    const { client, calls } = make(() => ({
      body: [
        { name: 'chip-01', status: 'WORKING', me: { id: '551199990001@c.us', pushName: 'Consultor' } },
        { name: 'mag_x', status: 'SCAN_QR_CODE', me: null },
      ],
    }));
    expect(await client.listSessions()).toEqual([
      { name: 'chip-01', status: 'WORKING', phone: '+551199990001', pushName: 'Consultor' },
      { name: 'mag_x', status: 'SCAN_QR_CODE', phone: null },
    ]);
    expect(calls[0]!.url).toBe('http://waha:3000/api/sessions?all=true');
  });

  it('editar = PUT {text}; fixar 0 s = unpin; capability editMessage', async () => {
    const { client, calls } = make();
    await client.editMessage('a', '1203630000000002@g.us', 'M1', 'novo');
    await client.pinMessage('a', '1203630000000002@g.us', 'M1', 86_400);
    await client.pinMessage('a', '1203630000000002@g.us', 'M1', 0);
    expect(calls.map((c) => [`${c.method} ${c.url.replace('http://waha:3000', '')}`, c.body])).toEqual([
      ['PUT /api/a/chats/1203630000000002%40g.us/messages/M1', { text: 'novo' }],
      ['POST /api/a/chats/1203630000000002%40g.us/messages/M1/pin', { duration: 86_400 }],
      ['POST /api/a/chats/1203630000000002%40g.us/messages/M1/unpin', undefined],
    ]);
    expect(client.capabilities().editMessage).toBe(true);
  });

  it('vídeo instantâneo = sendVideo asNote; figurinha = WaNotSupportedError (sem chamada)', async () => {
    const { client, calls } = make(() => ({ body: { id: 'V1' } }));
    await client.send('a', '5511999990005@c.us', { type: 'video', url: 'https://x/v.mp4', asNote: true });
    expect(calls[0]!.body).toMatchObject({ asNote: true, file: { url: 'https://x/v.mp4' } });
    await expect(client.send('a', '5511999990005@c.us', { type: 'sticker', url: 'https://x/s.webp' })).rejects.toBeInstanceOf(
      WaNotSupportedError,
    );
    expect(calls).toHaveLength(1);
  });

  it('start/stop/logout/delete', async () => {
    const { client, calls } = make();
    await client.startSession('a');
    await client.stopSession('a');
    await client.logoutSession('a');
    await client.deleteSession('a');
    expect(calls.map((c) => `${c.method} ${c.url.replace('http://waha:3000', '')}`)).toEqual([
      'POST /api/sessions/a/start',
      'POST /api/sessions/a/stop',
      'POST /api/sessions/a/logout',
      'DELETE /api/sessions/a',
    ]);
  });

  it('getQr devolve data-url e impõe ciclo de 5', async () => {
    const { client, calls } = make(() => ({ body: { mimetype: 'image/png', data: 'AAA' } }));
    for (let i = 1; i <= 5; i++) expect(await client.getQr('a')).toEqual({ image: 'data:image/png;base64,AAA', attempt: i });
    await expect(client.getQr('a')).rejects.toBeInstanceOf(QrCycleExhaustedError);
    expect(calls[0]!.url).toContain('/api/a/auth/qr?format=image');
    client.qrCycle.reset('a');
    expect((await client.getQr('a')).attempt).toBe(1);
  });

  it('getStatus / getMe', async () => {
    const { client } = make((c) =>
      c.url.endsWith('/me') ? { body: { id: '5511999990006@c.us', pushName: 'Chip' } } : { body: { status: 'WORKING' } },
    );
    expect(await client.getStatus('a')).toBe('WORKING');
    expect(await client.getMe('a')).toEqual({ jid: '5511999990006@c.us', lid: undefined, pushName: 'Chip', platform: undefined });
  });

  it('createGroup busca invite code', async () => {
    const { client, calls } = make((c) =>
      c.url.endsWith('/invite-code') ? { body: 'https://chat.whatsapp.com/ABC' } : { body: { JID: '1203630000000002@g.us' } },
    );
    const r = await client.createGroup('a', { subject: 'Turma #1', participants: ['5511999990005@c.us'] });
    expect(r).toEqual({ gid: '1203630000000002@g.us', inviteCode: 'https://chat.whatsapp.com/ABC' });
    expect(calls[0]!.body).toEqual({ name: 'Turma #1', participants: [{ id: '5511999990005@c.us' }] });
    expect(calls[1]!.url).toContain('/api/a/groups/1203630000000002%40g.us/invite-code');
  });

  it('getGroup normaliza payload GOWS', async () => {
    const { client } = make(() => ({
      body: {
        JID: '1203630000000002@g.us',
        Name: 'Turma',
        Topic: 'desc',
        IsAnnounce: true,
        Participants: [
          { JID: '100000000000003@lid', PhoneNumber: '5511999990005@c.us', LID: '100000000000003@lid', IsAdmin: true, IsSuperAdmin: true },
          { JID: '5511999990007@c.us', IsAdmin: false, IsSuperAdmin: false },
        ],
      },
    }));
    const g = await client.getGroup('a', '1203630000000002@g.us');
    expect(g).toMatchObject({ gid: '1203630000000002@g.us', subject: 'Turma', description: 'desc', announce: true });
    expect(g.participants).toEqual([
      { jid: '5511999990005@c.us', lid: '100000000000003@lid', isAdmin: true, isSuperAdmin: true },
      { jid: '5511999990007@c.us', lid: undefined, isAdmin: false, isSuperAdmin: false },
    ]);
  });

  it('listGroups: GET /api/{sessao}/groups normaliza cada grupo', async () => {
    const { client, calls } = make(() => ({
      body: [
        { JID: '1203630000000001@g.us', Name: 'Turma' },
        { id: '1203630000000002@g.us', subject: 'Outra' },
      ],
    }));
    const gs = await client.listGroups('a');
    expect(calls[0]!.url).toBe('http://waha:3000/api/a/groups');
    expect(gs.map((g) => [g.gid, g.subject])).toEqual([
      ['1203630000000001@g.us', 'Turma'],
      ['1203630000000002@g.us', 'Outra'],
    ]);
  });

  it('listGroups: resposta em objeto indexado por id também vira lista (não some em silêncio)', async () => {
    const { client } = make(() => ({ body: { '1203630000000001@g.us': { JID: '1203630000000001@g.us', Name: 'Turma' } } }));
    expect((await client.listGroups('a')).map((g) => [g.gid, g.subject])).toEqual([['1203630000000001@g.us', 'Turma']]);
    const empty = make(() => ({ body: null }));
    expect(await empty.client.listGroups('a')).toEqual([]);
  });

  it('setSettings mapeia p/ endpoints de security; ephemeral não suportado', async () => {
    const { client, calls } = make(() => ({ body: true }));
    await client.setSettings('a', '1203630000000001@g.us', { announce: true, locked: false, approvalMode: true });
    expect(calls.map((c) => [c.url.split('/settings/security/')[1], c.body])).toEqual([
      ['messages-admin-only', { adminsOnly: true }],
      ['info-admin-only', { adminsOnly: false }],
      ['membership-approval', { newMembersApprovalRequired: true }],
    ]);
    await expect(client.setSettings('a', 'g', { ephemeralSec: 86400 })).rejects.toBeInstanceOf(WaNotSupportedError);
  });

  it('participants/admin/join-requests → PerJidResult', async () => {
    const { client, calls } = make((c) =>
      c.url.includes('join-requests/approve')
        ? { body: [{ requesterId: '5511999990008@c.us', success: true }, { requesterId: '5511999990009@c.us', success: false }] }
        : { body: {} },
    );
    expect(await client.addParticipants('a', 'g', ['5511999990008@c.us'])).toEqual([{ jid: '5511999990008@c.us', ok: true }]);
    await client.removeParticipants('a', 'g', ['5511999990008@c.us']);
    await client.promote('a', 'g', ['5511999990008@c.us']);
    await client.demote('a', 'g', ['5511999990008@c.us']);
    expect(await client.approveJoinRequests('a', 'g', ['5511999990008@c.us', '5511999990009@c.us'])).toEqual([
      { jid: '5511999990008@c.us', ok: true },
      { jid: '5511999990009@c.us', ok: false, error: 'failed' },
    ]);
    await client.rejectJoinRequests('a', 'g', ['5511999990008@c.us']);
    expect(calls.map((c) => c.url.split('/groups/g')[1])).toEqual([
      '/participants/add',
      '/participants/remove',
      '/admin/promote',
      '/admin/demote',
      '/participants/join-requests/approve',
      '/participants/join-requests/reject',
    ]);
  });

  it('listJoinRequests', async () => {
    const { client } = make(() => ({
      body: [{ requesterId: '100000000000004@lid', requesterPn: '5511999990005@c.us', requestMethod: 'invite_link', timestamp: 10 }],
    }));
    expect(await client.listJoinRequests('a', 'g')).toEqual([
      { jid: '5511999990005@c.us', lid: '100000000000004@lid', requestedAt: 10000, method: 'invite_link' },
    ]);
  });

  it('send por tipo de bloco, mentions all', async () => {
    const { client, calls } = make(() => ({ body: { id: { _serialized: 'true_g_ABC' } } }));
    const chat = '1203630000000002@g.us';
    expect(await client.send('a', chat, { type: 'text', text: 'oi' }, { mentions: ['all'] })).toEqual({ id: 'true_g_ABC' });
    await client.send('a', chat, { type: 'image', url: 'u', caption: 'c' });
    await client.send('a', chat, { type: 'file', url: 'u', filename: 'f.pdf' });
    await client.send('a', chat, { type: 'voice', url: 'u' });
    await client.send('a', chat, { type: 'video', url: 'u' });
    await client.send('a', chat, { type: 'poll', name: 'P', options: ['a', 'b'] });
    await client.send('a', chat, { type: 'event', name: 'Live', startTime: 1 });
    expect(calls.map((c) => c.url.replace('http://waha:3000', ''))).toEqual([
      '/api/sendText',
      '/api/sendImage',
      '/api/sendFile',
      '/api/sendVoice',
      '/api/sendVideo',
      '/api/sendPoll',
      '/api/a/events',
    ]);
    expect(calls[0]!.body).toMatchObject({ session: 'a', chatId: chat, text: 'oi', mentions: ['all'] });
    expect(calls[5]!.body).toMatchObject({ poll: { name: 'P', options: ['a', 'b'], multipleAnswers: false } });
    expect(calls[2]!.body).toMatchObject({ file: { url: 'u', filename: 'f.pdf' } });
  });

  it('mídia com `data` (base64) vai como file.data, sem url', async () => {
    const { client, calls } = make(() => ({ body: { id: 'x' } }));
    await client.send('a', '1203630000000001@g.us', { type: 'voice', url: 'https://signed/x.ogg', data: 'AAEC', mimetype: 'audio/ogg; codecs=opus' });
    await client.send('a', '1203630000000001@g.us', { type: 'file', url: 'u', data: 'AAEC', filename: 'a.pdf', mimetype: 'application/pdf' });
    expect(calls[0]!.body).toMatchObject({ file: { data: 'AAEC', mimetype: 'audio/ogg; codecs=opus' }, convert: true });
    expect((calls[0]!.body as { file: Record<string, unknown> }).file.url).toBeUndefined();
    expect(calls[1]!.body).toMatchObject({ file: { data: 'AAEC', filename: 'a.pdf', mimetype: 'application/pdf' } });
  });

  it('check-exists no shape real do GOWS (chatId = LID, pn = variante real) + lids/{lid}', async () => {
    const { client, calls } = make((c) =>
      c.url.includes('check-exists')
        ? { body: { numberExists: true, chatId: '100000000000001@lid', pn: '551199990002@c.us' } }
        : { body: { lid: '100000000000001@lid', pn: '551199990002@c.us' } },
    );
    expect(await client.checkNumber('chip-01', '5511999990002')).toEqual({
      exists: true,
      jid: '551199990002@c.us',
      lid: '100000000000001@lid',
    });
    expect(await client.phoneOfLid('chip-01', '100000000000001@lid')).toBe('551199990002@c.us');
    expect(calls[1]!.url).toBe('http://waha:3000/api/chip-01/lids/100000000000001%40lid');
  });

  it('listMessages: GET chats/{chat}/messages (limite 1–200), autor = participant, LID/telefone, ts em ms', async () => {
    const { client, calls } = make(() => ({
      body: [
        {
          id: 'false_1203630000000001@g.us_A1_100000000000050@lid',
          timestamp: 1792115700,
          from: '1203630000000001@g.us',
          fromMe: false,
          participant: '100000000000001@lid',
          body: 'compre aqui',
          hasMedia: false,
          _data: { Info: { Sender: '100000000000001@lid', SenderAlt: '551199990002@s.whatsapp.net' } },
        },
        { id: { _serialized: 'true_1203630000000001@g.us_B2' }, timestamp: 1792115800, from: '1203630000000001@g.us', fromMe: true, participant: '5511999990010@c.us' },
        { timestamp: 1 }, // sem id/autor → descartada
      ],
    }));
    expect(await client.listMessages('a', '1203630000000001@g.us', { limit: 500 })).toEqual([
      {
        id: 'false_1203630000000001@g.us_A1_100000000000050@lid',
        from: '100000000000001@lid',
        fromAlt: '551199990002@s.whatsapp.net',
        fromMe: false,
        body: 'compre aqui',
        hasMedia: false,
        ts: 1792115700000,
      },
      { id: 'true_1203630000000001@g.us_B2', from: '5511999990010@c.us', fromMe: true, hasMedia: false, ts: 1792115800000 },
    ]);
    expect(calls[0]!.url).toBe('http://waha:3000/api/a/chats/1203630000000001%40g.us/messages?limit=200&downloadMedia=false');
  });

  it('getProfilePicture: GET contacts/profile-picture; sem o campo -> null', async () => {
    const { client, calls } = make((c) =>
      c.url.includes('5511999990005') ? { body: { profilePictureURL: 'https://pps.whatsapp.net/a.jpg' } } : { body: {} },
    );
    expect(await client.getProfilePicture('s', '5511999990005@c.us')).toBe('https://pps.whatsapp.net/a.jpg');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe(
      'http://waha:3000/api/contacts/profile-picture?contactId=5511999990005%40c.us&session=s&refresh=false',
    );
    expect(await client.getProfilePicture('s', '5511999990011@c.us')).toBeNull();
  });

  it('getContactName: pushname, senão name, vazio -> null, 404 -> null, outros erros sobem', async () => {
    const bodies: Record<string, unknown> = {
      '5511999990008@c.us': { pushname: 'Zé', name: 'José' },
      '5511999990009@c.us': { name: 'Maria' },
      '5511999990012@c.us': { pushname: '', name: '' },
    };
    const { client, calls } = make((c) => {
      const id = decodeURIComponent(new URL(c.url).searchParams.get('contactId') ?? '');
      if (id === '5511999990013@c.us') return { status: 404, body: 'nope' };
      if (id === '5511999990014@c.us') return { status: 500, body: 'boom' };
      return { body: bodies[id] };
    });
    expect(await client.getContactName('s', '5511999990008@c.us')).toBe('Zé');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('http://waha:3000/api/contacts?contactId=5511999990008%40c.us&session=s');
    expect(await client.getContactName('s', '5511999990009@c.us')).toBe('Maria');
    expect(await client.getContactName('s', '5511999990012@c.us')).toBeNull();
    expect(await client.getContactName('s', '5511999990013@c.us')).toBeNull();
    await expect(client.getContactName('s', '5511999990014@c.us')).rejects.toBeInstanceOf(WahaHttpError);
  });

  it('pin/delete/check-exists/invite revoke/join/leave', async () => {
    const { client, calls } = make((c) =>
      c.url.includes('check-exists') ? { body: { numberExists: true, chatId: '5511999990005@c.us' } } : { body: 'NEW' },
    );
    await client.pinMessage('a', '1203630000000001@g.us', 'm1', 86400);
    await client.deleteMessage('a', '1203630000000001@g.us', 'm1');
    expect(await client.checkNumber('a', '5511')).toEqual({ exists: true, jid: '5511999990005@c.us' });
    expect(await client.revokeInviteCode('a', 'g')).toBe('NEW');
    await client.joinGroup('a', 'CODE');
    await client.leaveGroup('a', 'g');
    expect(calls.map((c) => `${c.method} ${c.url.replace('http://waha:3000', '')}`)).toEqual([
      'POST /api/a/chats/1203630000000001%40g.us/messages/m1/pin',
      'DELETE /api/a/chats/1203630000000001%40g.us/messages/m1',
      'GET /api/contacts/check-exists?phone=5511&session=a',
      'POST /api/a/groups/g/invite-code/revoke',
      'POST /api/a/groups/join',
      'POST /api/a/groups/g/leave',
    ]);
  });

  it('erro HTTP vira WahaHttpError', async () => {
    const { client } = make(() => ({ status: 422, body: { message: 'bad' } }));
    await expect(client.startSession('a')).rejects.toBeInstanceOf(WahaHttpError);
  });

  it('capabilities GOWS honestas', () => {
    expect(make().client.capabilities()).toEqual({
      communities: false,
      polls: true,
      events: true,
      joinRequests: true,
      // temporária por envio e GIF animado não existem no GOWS; vCard sim (sendContactVcard)
      ephemeral: false,
      gif: false,
      vcard: true,
      // PUT de edição documentado no GOWS (validação real num chip de teste)
      editMessage: true,
      // vídeo instantâneo (sendVideo asNote) sim; figurinha/botões/lista/Pix não
      videoNote: true,
      sticker: false,
      buttons: false,
      list: false,
      pix: false,
    });
  });

  it('vCard → POST /api/sendContactVcard; prévia de link desligada; GIF sai como vídeo', async () => {
    const { client, calls } = make(() => ({ body: { id: 'V1' } }));
    await client.send('a', '5511999990005@c.us', { type: 'contact', name: 'Suporte', phone: '+5511999990015', organization: 'Empresa Exemplo' });
    await client.send('a', '5511999990005@c.us', { type: 'text', text: 'https://x.test' }, { linkPreview: false });
    await client.send('a', '5511999990005@c.us', { type: 'video', url: 'u.mp4', gif: true });
    expect(calls[0]!.url).toBe('http://waha:3000/api/sendContactVcard');
    expect(calls[0]!.body).toEqual({
      session: 'a',
      chatId: '5511999990005@c.us',
      contacts: [{ fullName: 'Suporte', organization: 'Empresa Exemplo', phoneNumber: '+5511999990015', whatsappId: '5511999990015' }],
    });
    expect(calls[1]!.body).toMatchObject({ linkPreview: false });
    expect(calls[2]!.url).toBe('http://waha:3000/api/sendVideo');
  });
});

describe('timeout', () => {
  it('aborta requisição pendurada e lança WahaHttpError 408 sem travar', async () => {
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const c = new WahaClient({ baseUrl: 'http://waha', fetch: hang, timeoutMs: 20 });
    const t0 = Date.now();
    await expect(c.getStatus('s1')).rejects.toMatchObject({ status: 408 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(hang).toHaveBeenCalledTimes(1);
  });

  it('envio de mídia usa o timeout de mídia (maior), não o geral (vídeo de 16 MB deu 408 em 30 s)', async () => {
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const c = new WahaClient({ baseUrl: 'http://waha', fetch: hang, timeoutMs: 20, mediaTimeoutMs: 300 });
    const t0 = Date.now();
    await expect(
      c.send('s1', '1203630000000003@g.us', { type: 'video', url: 'https://x/v.mp4', mimetype: 'video/mp4' } as never),
    ).rejects.toMatchObject({ status: 408 });
    const dt = Date.now() - t0;
    expect(dt).toBeGreaterThanOrEqual(250);
    expect(dt).toBeLessThan(2000);
  });
});
