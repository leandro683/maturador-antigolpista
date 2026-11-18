import type { WahaWebhook } from '@mag/wa-engine';
import { describe, expect, it } from 'vitest';
import { createSecHandlers, loadSecContext, onGroupUpdate, onMessage, onParticipants, onReaction, rawActor } from '../src/handlers';
import { identityOf } from '../src/identity';
import { ReactionLimiter } from '../src/limiter';
import {
  ADMIN_TEAM,
  demoteWebhook,
  ev,
  GID,
  HACKER,
  ME,
  messageWebhook,
  promoteWebhook,
  reactionWebhook,
  sample,
  setup,
  subjectWebhook,
} from './fixtures';

describe('message.in', () => {
  it('grupo consta fechado no banco mas está aberto ao vivo (ou o motor não responde) → não pune', async () => {
    for (const live of [async () => ({ gid: GID, subject: '', participants: [], announce: false }), async () => { throw new Error('waha fora'); }]) {
      const { repo, engine, calls } = setup();
      (engine as { getGroup: unknown }).getGroup = live;
      const r = await onMessage(ev<'message.in'>(messageWebhook(HACKER, 'oi')), { repo, engine });
      expect(r.note).toBe('grupo aberto ao vivo');
      expect(calls).toEqual([]);
      expect(repo.blocked).toEqual([]);
      expect(repo.incidents).toHaveLength(0);
    }
  });

  it('não-admin em grupo fechado → apaga + remove + bloqueia + incidente', async () => {
    const { repo, engine, calls } = setup();
    const w = messageWebhook(HACKER, 'oi');
    const r = await onMessage(ev<'message.in'>(w), { repo, engine });
    expect(r.note).toBe('violação: closed-group');
    expect(calls.map((c) => c.op)).toEqual(['deleteMessage', 'removeParticipants']);
    expect(calls[0]!.session).toBe('chip-01'); // conta dona do grupo age, não a espiã
    expect(calls[0]!.args).toEqual([GID, (w.payload as { id: string }).id]);
    expect(calls[1]!.args).toEqual([GID, [`${HACKER}@c.us`]]);
    expect(repo.blocked).toEqual([
      expect.objectContaining({ campaignId: 'c1', name: `Hacker de mensagem +${HACKER}`, toAntiSpam: true }),
    ]);
    expect(repo.incidents).toHaveLength(1);
    expect(repo.incidents[0]).toMatchObject({ kind: 'message', status: 'acted', who: { number: `+${HACKER}` } });
  });

  it('mesmo evento recebido por outra conta (espiã) não age 2×', async () => {
    const { repo, engine, calls } = setup();
    const w = messageWebhook(HACKER, 'oi');
    await onMessage(ev<'message.in'>(w), { repo, engine });
    const spyCopy = { ...w, session: 'spy1' };
    await onMessage(ev<'message.in'>(spyCopy), { repo, engine });
    expect(calls).toHaveLength(2);
    expect(repo.incidents).toHaveLength(1);
  });

  it('número administrativo, conta da campanha e colaborador passam', async () => {
    const { repo, engine, calls } = setup();
    repo.trustedByCampaign.set('c1', [identityOf('5511999990011')]);
    for (const from of [ADMIN_TEAM, ME, '5511999990011'])
      expect((await onMessage(ev<'message.in'>(messageWebhook(from, 'oi', from)), { repo, engine })).note).toBe(
        'allowlisted',
      );
    expect(calls).toHaveLength(0);
  });

  it('grupo aberto: só conteúdo suspeito (link/pix/convite)', async () => {
    const { repo, engine, calls } = setup({ onlyAdminsSpeak: false }, { announce: false });
    expect((await onMessage(ev<'message.in'>(messageWebhook(HACKER, 'bom dia', 'a')), { repo, engine })).note).toBe(
      'open-group',
    );
    const r = await onMessage(ev<'message.in'>(messageWebhook(HACKER, 'manda no PIX 123', 'b')), { repo, engine });
    expect(r.note).toBe('violação: suspicious');
    expect(calls.map((c) => c.op)).toEqual(['deleteMessage', 'removeParticipants']);
  });

  it('desligado ou dry-run não age', async () => {
    const off = setup({ antiHacker: { enabled: false } });
    await onMessage(ev<'message.in'>(messageWebhook(HACKER, 'x')), off);
    expect(off.calls).toHaveLength(0);
    const dry = setup({ antiHacker: { enabled: true, dryRun: true } });
    await onMessage(ev<'message.in'>(messageWebhook(HACKER, 'x')), dry);
    expect(dry.calls).toHaveLength(0);
    expect(dry.repo.blocked).toHaveLength(0);
    expect(dry.repo.incidents[0]!.status).toBe('dry_run');
  });

  it('respeita deleteNonAdminMessages/removeAuthor/sendToAntiSpam', async () => {
    const s = setup({
      antiHacker: { enabled: true, deleteNonAdminMessages: false, removeAuthor: false, sendToAntiSpam: false },
    });
    await onMessage(ev<'message.in'>(messageWebhook(HACKER, 'x')), s);
    expect(s.calls).toHaveLength(0);
    expect(s.repo.blocked[0]!.toAntiSpam).toBe(false);
  });
});

describe('group.participants promote', () => {
  it('promoção de número fora da allowlist → rebaixa + remove (promovido e autor) + alerta', async () => {
    const { repo, engine, calls } = setup();
    const accomplice = '5511999990012';
    const r = await onParticipants(ev<'group.participants'>(promoteWebhook(HACKER, accomplice)), { repo, engine }, promoteWebhook(HACKER, accomplice));
    expect(r.note).toBe('promoção não autorizada');
    expect(calls.map((c) => c.op)).toEqual(['demote', 'removeParticipants']);
    expect(calls[0]!.args).toEqual([GID, [`${HACKER}@c.us`, `${accomplice}@s.whatsapp.net`]]);
    expect(repo.incidents[0]).toMatchObject({ kind: 'promote', severity: 'critical', status: 'acted' });
    expect(repo.alerts.map((a) => a.type)).toEqual(['security.unauthorized-promote']);
  });

  it('promoção de número administrativo pela própria conta → nada', async () => {
    const { repo, engine, calls } = setup();
    const w = promoteWebhook(ADMIN_TEAM, ME);
    expect((await onParticipants(ev<'group.participants'>(w), { repo, engine }, w)).note).toBe('promoção autorizada');
    expect(calls).toHaveLength(0);
  });
});

describe('conta da campanha rebaixada/removida', () => {
  it('rebaixada por estranho → alerta crítico + re-promove via outra conta + rebaixa autor', async () => {
    const { repo, engine, calls } = setup();
    const w = demoteWebhook(ME, HACKER);
    const r = await onParticipants(ev<'group.participants'>(w), { repo, engine }, w);
    expect(r.note).toBe('conta da campanha perdeu admin');
    expect(calls[0]).toMatchObject({ op: 'promote', session: 'spy1', args: [GID, [`${ME}@c.us`]] });
    expect(calls.map((c) => c.op)).toEqual(['promote', 'demote', 'removeParticipants']);
    expect(repo.alerts[0]!.type).toBe('security.admin-lost');
  });

  it('autor só com LID (sem telefone para conferir a lista oficial): re-promove a conta, mas não pune o autor', async () => {
    const { repo, engine, calls } = setup();
    const w = demoteWebhook(ME, HACKER);
    const d = (w.payload as { _data: Record<string, unknown> })._data;
    d.Sender = '100000000000002@lid';
    d.SenderPN = null;
    const r = await onParticipants(ev<'group.participants'>(w), { repo, engine }, w);
    expect(r.note).toBe('conta da campanha perdeu admin');
    expect(calls.map((c) => c.op)).toEqual(['promote']);
    expect(calls[0]).toMatchObject({ session: 'spy1', args: [GID, [`${ME}@c.us`]] });
    expect(repo.incidents[0]!.actions).toEqual([
      { type: 're-promover', target: `${ME}@c.us`, ok: true },
      { type: 'verificar-autor', ok: false, error: 'sem telefone para conferir a lista oficial' },
    ]);
  });

  it('removida → re-adiciona antes de promover', async () => {
    const { repo, engine, calls } = setup();
    const w = demoteWebhook(ME, HACKER, 'remove');
    await onParticipants(ev<'group.participants'>(w), { repo, engine }, w);
    expect(calls.slice(0, 2).map((c) => c.op)).toEqual(['addParticipants', 'promote']);
  });

  it('rebaixada por admin autorizado → só registra', async () => {
    const { repo, engine, calls } = setup();
    const w = demoteWebhook(ME, ADMIN_TEAM);
    expect((await onParticipants(ev<'group.participants'>(w), { repo, engine }, w)).note).toMatch(/autorizado/);
    expect(calls).toHaveLength(0);
  });
});

describe('group.update', () => {
  it('nome trocado por estranho → reverte p/ o nome do painel', async () => {
    const { repo, engine, calls } = setup();
    const w = subjectWebhook('GANHE PIX AQUI', HACKER);
    const r = await onGroupUpdate(ev<'group.update'>(w), { repo, engine }, w);
    expect(r.note).toBe('alteração não autorizada');
    expect(calls[0]).toMatchObject({ op: 'setSubject', args: [GID, 'Lançamento #1'] });
    expect(repo.incidents[0]).toMatchObject({ kind: 'group_update', status: 'acted' });
  });

  it('webhook de exemplo (autor = conta da campanha) não reverte', async () => {
    const { repo, engine, calls } = setup();
    const w = sample('group.v2.update');
    expect(rawActor(w)).toBe(`${ME}@s.whatsapp.net`);
    expect((await onGroupUpdate(ev<'group.update'>(w), { repo, engine }, w)).note).toBe('alteração autorizada');
    expect(calls).toHaveLength(0);
  });
});

describe('loop guard', () => {
  it('reverte no máx. N vezes por janela; depois só registra rate_limited', async () => {
    const { repo, engine, calls } = setup();
    let t = 0;
    const limiter = new ReactionLimiter(2, 60_000, () => t);
    for (let i = 0; i < 4; i++) {
      const w = subjectWebhook(`hack ${i}`, HACKER);
      await onGroupUpdate(ev<'group.update'>(w), { repo, engine, limiter }, w);
    }
    expect(calls.filter((c) => c.op === 'setSubject')).toHaveLength(2);
    expect(repo.incidents.map((i) => i.status)).toEqual(['acted', 'acted', 'rate_limited', 'rate_limited']);
    t = 61_000;
    const w = subjectWebhook('hack 5', HACKER);
    await onGroupUpdate(ev<'group.update'>(w), { repo, engine, limiter }, w);
    expect(calls.filter((c) => c.op === 'setSubject')).toHaveLength(3);
  });

  it('nosso próprio revert (evento com autor = conta) não dispara outro revert', async () => {
    const { repo, engine, calls } = setup();
    const w = subjectWebhook('Lançamento #1', ME);
    expect((await onGroupUpdate(ev<'group.update'>(w), { repo, engine }, w)).note).toBe('sem mudança');
    const w2 = subjectWebhook('outro nome', ME);
    expect((await onGroupUpdate(ev<'group.update'>(w2), { repo, engine }, w2)).note).toBe('alteração autorizada');
    expect(calls).toHaveLength(0);
  });
});

describe('bloqueado entrou', () => {
  const add = (who: string) =>
    sample('group.v2.participants.leave', (w) => {
      const p = w.payload as Record<string, unknown>;
      p.type = 'join';
      p.participants = [{ id: `${who}@c.us`, pn: null, role: 'participant' }];
    });

  it('proteção ligada: remove quem está bloqueado; ignora os demais', async () => {
    const { repo, engine, calls } = setup({ antiHacker: { enabled: true } });
    repo.preBlocked.add(identityOf(HACKER));
    const h = createSecHandlers({ repo, engine });
    await h['group.participants'](ev<'group.participants'>(add('5511999990013')), { raw: null });
    expect(calls).toHaveLength(0);
    await h['group.participants'](ev<'group.participants'>(add(HACKER)), { raw: null });
    expect(calls).toEqual([{ op: 'removeParticipants', session: 'chip-01', args: [GID, [`${HACKER}@c.us`]] }]);
    expect(repo.incidents[0]).toMatchObject({ kind: 'blocked_join', severity: 'info', status: 'acted' });
  });

  it('proteção desligada (padrão): o bloqueado continua no grupo e nada é registrado', async () => {
    for (const antiHacker of [null, { enabled: false }]) {
      const { repo, engine, calls } = setup({ antiHacker });
      repo.preBlocked.add(identityOf(HACKER));
      const h = createSecHandlers({ repo, engine });
      await h['group.participants'](ev<'group.participants'>(add(HACKER)), { raw: null });
      expect(calls).toHaveLength(0);
      expect(repo.incidents).toHaveLength(0);
    }
  });

  it('modo simulação: não remove e registra o incidente como simulado', async () => {
    const { repo, engine, calls } = setup({ antiHacker: { enabled: true, dryRun: true } });
    repo.preBlocked.add(identityOf(HACKER));
    const h = createSecHandlers({ repo, engine });
    await h['group.participants'](ev<'group.participants'>(add(HACKER)), { raw: null });
    expect(calls).toHaveLength(0);
    expect(repo.incidents[0]).toMatchObject({ kind: 'blocked_join', status: 'dry_run' });
  });
});

describe('anti-hacker por reações', () => {
  const MEMBER = '5511999990014'; // membro comum (fora da allowlist)
  const COLLAB = '5511999990011';
  const ON = { antiHacker: { enabled: true, reactionProtection: true } };
  const on = (over: Record<string, unknown> = {}) => {
    const s = setup({ antiHacker: { ...ON.antiHacker, ...over } });
    s.repo.trustedByCampaign.set('c1', [identityOf(COLLAB)]);
    return { ...s, limiter: new ReactionLimiter() }; // cota própria (o limiter padrão é do processo)
  };

  it('reator membro comum (fora da allowlist) → nada (não deixa membro derrubar outro)', async () => {
    const s = on();
    expect((await onReaction(ev<'message.reaction'>(reactionWebhook(MEMBER, HACKER)), s)).note).toBe(
      'reator não é da equipe',
    );
    expect(s.calls).toHaveLength(0);
    expect(s.repo.incidents).toHaveLength(0);
  });

  it('reator colaborador → age (apaga + remove + bloqueia)', async () => {
    const s = on();
    const r = await onReaction(ev<'message.reaction'>(reactionWebhook(COLLAB, HACKER)), s);
    expect(r.note).toBe('violação: closed-group');
    expect(s.calls.map((c) => c.op)).toEqual(['deleteMessage', 'removeParticipants']);
    expect(s.repo.blocked).toHaveLength(1);
  });

  it('padrão: reactionProtection desligado (só age com a campanha ligando explicitamente)', async () => {
    const s = setup({ antiHacker: { enabled: true } });
    expect((await onReaction(ev<'message.reaction'>(reactionWebhook(ADMIN_TEAM, HACKER)), s)).note).toBe(
      'proteção por reações desligada',
    );
    expect(s.calls).toHaveLength(0);
  });

  it('deleteNonAdminMessages desligado → remove e bloqueia sem apagar', async () => {
    const s = on({ deleteNonAdminMessages: false });
    await onReaction(ev<'message.reaction'>(reactionWebhook(ADMIN_TEAM, HACKER)), s);
    expect(s.calls.map((c) => c.op)).toEqual(['removeParticipants']);
    expect(s.repo.blocked).toHaveLength(1);
  });

  it('emoji vazio (reação removida) → ignorado', async () => {
    const s = on();
    expect((await onReaction(ev<'message.reaction'>(reactionWebhook(ADMIN_TEAM, HACKER, 'e', false, '')), s)).note).toBe(
      'reação removida',
    );
    expect(s.calls).toHaveLength(0);
  });

  it('reator admin a mensagem de não-colaborador em grupo fechado → incidente + apaga a mensagem', async () => {
    const { repo, engine, calls } = setup(ON);
    const h = createSecHandlers({ repo, engine });
    const w = reactionWebhook(ADMIN_TEAM, HACKER);
    const r = await h['message.reaction'](ev<'message.reaction'>(w));
    expect(r.note).toBe('violação: closed-group');
    const msgId = `false_${GID}_3EB0HACK0001_${HACKER}@c.us`;
    expect(calls[0]).toEqual({ op: 'deleteMessage', session: 'chip-01', args: [GID, msgId] });
    expect(repo.incidents).toHaveLength(1);
    expect(repo.incidents[0]).toMatchObject({
      kind: 'reaction',
      status: 'acted',
      messageId: msgId,
      who: { number: `+${HACKER}` },
      details: expect.objectContaining({ reactor: `+${ADMIN_TEAM}`, emoji: '😮' }),
    });
  });

  it('a mesma mensagem chegando depois como message.in (ou outra reação) não age de novo', async () => {
    const s = on();
    await onReaction(ev<'message.reaction'>(reactionWebhook(COLLAB, HACKER)), s);
    await onReaction(ev<'message.reaction'>(reactionWebhook(ADMIN_TEAM, HACKER)), s);
    await onMessage(ev<'message.in'>(messageWebhook(HACKER, 'golpe')), s);
    expect(s.calls.filter((c) => c.op === 'deleteMessage')).toHaveLength(1);
    expect(s.repo.incidents).toHaveLength(1);
  });

  it('mensagem de conta/nossa ou anti-hacker desligado → nada', async () => {
    const s = on();
    expect((await onReaction(ev<'message.reaction'>(reactionWebhook(ADMIN_TEAM, ME)), s)).note).toBe('allowlisted');
    expect((await onReaction(ev<'message.reaction'>(reactionWebhook(ADMIN_TEAM, HACKER, 'x', true)), s)).note).toBe(
      'mensagem nossa',
    );
    const offAll = setup({ antiHacker: { enabled: false, reactionProtection: true } });
    await onReaction(ev<'message.reaction'>(reactionWebhook(ADMIN_TEAM, HACKER)), offAll);
    expect([...s.calls, ...offAll.calls]).toHaveLength(0);
  });

  it('grupo aberto: reação não revela conteúdo → não age', async () => {
    const { repo, engine, calls } = setup({ ...ON, onlyAdminsSpeak: false }, { announce: false });
    expect(
      (await onReaction(ev<'message.reaction'>(reactionWebhook(ADMIN_TEAM, HACKER)), { repo, engine })).note,
    ).toBe('open-group');
    expect(calls).toHaveLength(0);
  });

  it('motor sem apagar (GOWS 501) → incidente partial + aviso no log; nada apagado do banco', async () => {
    const { repo, engine } = setup(ON);
    const logs: string[] = [];
    const eng = { ...engine, deleteMessage: async () => Promise.reject(new Error('501 Not Implemented')) };
    await onReaction(ev<'message.reaction'>(reactionWebhook(ADMIN_TEAM, HACKER)), {
      repo,
      engine: eng,
      limiter: new ReactionLimiter(),
      log: (m) => logs.push(m),
    });
    expect(repo.incidents[0]!.status).toBe('partial'); // apagar falhou; remover/bloquear seguiram
    expect(repo.incidents[0]!.actions[0]).toMatchObject({ type: 'apagar-mensagem', ok: false });
    expect(logs.join('\n')).toMatch(/não conseguiu apagar/);
  });
});

// o mapper entrega `lid` já com `@lid`: telefone + LID no mesmo participante não pode perder o LID
describe('participante com telefone e LID (lid já vem com @lid)', () => {
  const LID = '100000000000001@lid';
  const withPnLid = (w: WahaWebhook, pn: string) => {
    (w.payload as Record<string, unknown>).participants = [{ id: LID, pn: `${pn}@c.us`, role: 'participant' }];
    return w;
  };

  it('bloqueado só pelo LID que entra com telefone novo: é removido', async () => {
    const { repo, engine, calls } = setup();
    repo.preBlocked.add(identityOf(LID));
    const w = withPnLid(
      sample('group.v2.participants.leave', (x) => ((x.payload as Record<string, unknown>).type = 'join')),
      HACKER,
    );
    await onParticipants(ev<'group.participants'>(w), { repo, engine }, w);
    expect(calls).toEqual([{ op: 'removeParticipants', session: 'chip-01', args: [GID, [`${HACKER}@c.us`]] }]);
    expect(repo.incidents[0]).toMatchObject({ kind: 'blocked_join' });
  });

  it('promovido autorizado só pelo LID (allowlist): promoção não é tratada como invasão', async () => {
    const { repo, engine, calls } = setup();
    repo.adminNumbers.push(identityOf(LID));
    const w = withPnLid(promoteWebhook(HACKER, ME), HACKER);
    expect((await onParticipants(ev<'group.participants'>(w), { repo, engine }, w)).note).toBe('promoção autorizada');
    expect(calls).toHaveLength(0);
  });

  it('conta da campanha rebaixada, reconhecida só pelo LID: perda de admin é detectada', async () => {
    const { repo, engine } = setup();
    repo.groups.get(GID)!.accounts[0]!.lid = LID; // como o getMe grava em wa_accounts.lid (com @lid)
    const w = withPnLid(demoteWebhook(ME, HACKER), '5511999990015');
    expect((await onParticipants(ev<'group.participants'>(w), { repo, engine }, w)).note).toBe(
      'conta da campanha perdeu admin',
    );
  });
});

// wa_accounts.lid guarda o valor do getMe com `@lid`: a conta nossa tem que entrar na lista oficial pelo LID
describe('conta com lid gravado com sufixo', () => {
  it('entra no allow e em ours por LID (chip nosso nunca é tratado como estranho)', async () => {
    const { repo } = setup();
    const LID = '100000000000001@lid';
    repo.groups.get(GID)!.accounts[0]!.lid = LID;
    const c = await loadSecContext(repo, GID, { announce: true } as never);
    expect(c!.allow.has(identityOf(LID))).toBe(true);
    expect(c!.ours.has(identityOf(LID))).toBe(true);
  });
});

// autor que chega só com LID (WAHA GOWS): a lista oficial casa por telefone, então resolve antes de julgar
describe('autor só com LID (resolver antes de julgar)', () => {
  const LID = '100000000000050';
  const lidMessage = (id = '3EB0LID00001') => {
    const w = messageWebhook(HACKER, 'oi', id);
    (w.payload as Record<string, unknown>).participant = `${LID}@lid`;
    return w;
  };
  const withPhone = (phone: string | null | (() => never)) => {
    const s = setup();
    const lookups: unknown[][] = [];
    const engine = {
      ...s.engine,
      phoneOfLid: async (...a: unknown[]) => {
        lookups.push(a);
        return typeof phone === 'function' ? phone() : phone;
      },
    } as unknown as typeof s.engine;
    return { ...s, engine, lookups, limiter: new ReactionLimiter() }; // cota própria (o limiter padrão é do processo)
  };

  it('LID que resolve para número da lista oficial → sem incidente nem bloqueio', async () => {
    const s = withPhone(`${ADMIN_TEAM}@c.us`);
    const r = await onMessage(ev<'message.in'>(lidMessage()), s);
    expect(r.note).toBe('allowlisted');
    expect(s.lookups[0]).toEqual(['chip-01', `${LID}@lid`]);
    expect(s.calls).toHaveLength(0);
    expect(s.repo.blocked).toHaveLength(0);
    expect(s.repo.incidents).toHaveLength(0);
  });

  it('LID que não resolve (vazio ou erro) → só incidente p/ revisão, nenhuma ação', async () => {
    for (const phone of [null, () => { throw new Error('boom'); }]) {
      const s = withPhone(phone);
      const r = await onMessage(ev<'message.in'>(lidMessage()), s);
      expect(r.note).toBe('violação: closed-group');
      expect(s.calls).toHaveLength(0);
      expect(s.repo.blocked).toHaveLength(0);
      expect(s.repo.incidents).toHaveLength(1);
      expect(s.repo.incidents[0]).toMatchObject({
        kind: 'message',
        status: 'open',
        who: { number: null, lid: LID },
        details: expect.objectContaining({ identity: 'número não identificado' }),
      });
    }
  });

  it('reação a mensagem de autor só com LID que não resolve → só incidente p/ revisão', async () => {
    const s = withPhone(null);
    s.repo.groups.get(GID)!.campaign.antiHacker = { enabled: true, reactionProtection: true };
    const w = reactionWebhook(ADMIN_TEAM, HACKER);
    const p = w.payload as { reaction: { messageId: string } };
    p.reaction.messageId = `false_${GID}_3EB0HACK0001_${LID}@lid`;
    await onReaction(ev<'message.reaction'>(w), s);
    expect(s.calls).toHaveLength(0);
    expect(s.repo.blocked).toHaveLength(0);
    expect(s.repo.incidents[0]).toMatchObject({ kind: 'reaction', status: 'open' });
  });

  it('LID que resolve para número de fora → continua bloqueado e o incidente traz o telefone', async () => {
    const s = withPhone(`${HACKER}@c.us`);
    const r = await onMessage(ev<'message.in'>(lidMessage()), s);
    expect(r.note).toBe('violação: closed-group');
    expect(s.calls.map((c) => c.op)).toEqual(['deleteMessage', 'removeParticipants']);
    expect(s.calls[1]!.args).toEqual([GID, [`${LID}@lid`]]);
    expect(s.repo.blocked).toEqual([expect.objectContaining({ who: expect.objectContaining({ number: `+${HACKER}` }) })]);
    expect(s.repo.incidents[0]).toMatchObject({ kind: 'message', status: 'acted', who: { number: `+${HACKER}`, lid: LID } });
  });

  it('promovido só com LID que resolve para a lista oficial → promoção autorizada', async () => {
    const s = withPhone(`${ADMIN_TEAM}@c.us`);
    const w = promoteWebhook(HACKER, ME);
    (w.payload as Record<string, unknown>).participants = [{ id: `${LID}@lid`, role: 'participant' }];
    expect((await onParticipants(ev<'group.participants'>(w), s, w)).note).toBe('promoção autorizada');
    expect(s.calls).toHaveLength(0);
  });
});
