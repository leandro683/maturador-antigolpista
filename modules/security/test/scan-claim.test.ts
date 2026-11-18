import { describe, expect, it } from 'vitest';
import type { Db } from '@mag/db';
import { actOnFindings } from '../src/scan';
import type { IncidentRow } from '../src/tables';
import { GID, setup } from './fixtures';

/**
 * Operador (Remover/Apagar/Ignorar): a transação só reivindica as linhas; o WhatsApp é chamado FORA de transação e cada
 * linha é fechada numa escrita própria. Banco de mentira: não avalia o SQL (isso é do scan.pg.test.ts) — registra a
 * ordem das operações e simula o claim (`details.claimedAt`) pelos ids que aparecem nos filtros.
 */
function fakeDb(rows: IncidentRow[]) {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  const claimed = new Set<string>();
  const log: string[] = [];
  let inTx = 0;
  const idsIn = (w: unknown, out = new Set<string>(), seen = new Set<unknown>()): Set<string> => {
    if (typeof w === 'string' && byId.has(w)) out.add(w);
    else if (w && typeof w === 'object' && !seen.has(w)) {
      seen.add(w);
      for (const v of Object.values(w)) idsIn(v, out, seen);
    }
    return out;
  };
  const db = {
    get inTx() {
      return inTx;
    },
    select: () => {
      let w: unknown;
      const q: Record<string, unknown> = {
        from: () => q,
        where: (x: unknown) => ((w = x), q),
        for: () => q,
        then: (ok: (v: IncidentRow[]) => void) => {
          log.push('select');
          ok([...idsIn(w)].filter((id) => !claimed.has(id) && !byId.get(id)!.resolvedAt).map((id) => byId.get(id)!));
        },
      };
      return q;
    },
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async (w: unknown) => {
          const ids = [...idsIn(w)];
          if ('status' in v) {
            for (const id of ids) {
              Object.assign(byId.get(id)!, { status: v.status, actions: v.actions ?? byId.get(id)!.actions });
              if (v.status === 'acted') byId.get(id)!.resolvedAt = new Date();
            }
            log.push(`finish:${ids.join(',')}`);
          } else if (inTx) {
            ids.forEach((id) => claimed.add(id));
            log.push('claim');
          } else {
            ids.forEach((id) => claimed.delete(id));
            log.push('release');
          }
        },
      }),
    }),
    insert: () => ({ values: async () => undefined }),
    transaction: async <T>(cb: (tx: unknown) => Promise<T>) => {
      inTx++;
      log.push('tx:begin');
      try {
        return await cb(db);
      } finally {
        inTx--;
        log.push('tx:end');
      }
    },
  };
  return { db: db as unknown as Db & { inTx: number }, byId, claimed, log };
}

const row = (n: number): IncidentRow =>
  ({
    id: `inc-${n}`,
    campaignId: 'c1',
    groupId: 'g1',
    waAccountId: 'acc-main',
    gid: GID,
    kind: 'scan.non-admin-message',
    severity: 'warning',
    status: 'open',
    phone: null,
    lid: null,
    actor: null,
    messageId: `msg-${n}`,
    actions: [],
    details: {},
    dedupKey: `k${n}`,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date(),
  }) as IncidentRow;

describe('actOnFindings: claim curto, WhatsApp fora da transação', () => {
  it('chama o WhatsApp sem transação aberta; 2º clique simultâneo não age de novo; claim é solto no fim', async () => {
    const { repo, engine } = setup();
    const f = fakeDb([row(1)]);
    let second: Awaited<ReturnType<typeof actOnFindings>> | undefined;
    const waha: number[] = [];
    const eng = {
      ...engine,
      deleteMessage: async () => {
        waha.push(f.db.inTx); // 0 = fora de transação
        // outro operador clica enquanto o WhatsApp responde: a linha já está reivindicada
        second = await actOnFindings({ db: f.db, engine: eng, repo, gapMs: 0 }, ['inc-1'], 'delete');
      },
    };
    const r = await actOnFindings({ db: f.db, engine: eng, repo, gapMs: 0 }, ['inc-1'], 'delete');
    expect(r).toMatchObject({ done: 1, failed: 0 });
    expect(waha).toEqual([0]); // só 1 chamada, fora da transação
    expect(second).toMatchObject({ done: 0, failed: 0, skipped: 1 });
    expect(f.byId.get('inc-1')).toMatchObject({ status: 'acted' });
    expect(f.claimed.size).toBe(0);
    // transação curta (select + claim) termina antes do WhatsApp; só depois vêm o fechamento da linha e o release
    expect(f.log.slice(0, 4)).toEqual(['tx:begin', 'select', 'claim', 'tx:end']);
    expect(f.log.indexOf('finish:inc-1')).toBeGreaterThan(f.log.indexOf('tx:end'));
  });

  it('falha no meio: linhas já feitas continuam gravadas, a que falhou volta a poder ser tentada', async () => {
    const { repo, engine } = setup();
    const f = fakeDb([row(1), row(2)]);
    const eng = {
      ...engine,
      deleteMessage: async (_s: string, _g: string, id: string) => {
        if (id === 'msg-2') throw new Error('WAHA 500');
      },
    };
    const r = await actOnFindings({ db: f.db, engine: eng, repo, gapMs: 0 }, ['inc-1', 'inc-2'], 'delete');
    expect(r).toMatchObject({ done: 1, failed: 1 });
    expect(f.byId.get('inc-1')).toMatchObject({ status: 'acted' });
    expect(f.byId.get('inc-2')).toMatchObject({ status: 'failed' });
    expect(f.claimed.size).toBe(0);
  });
});
