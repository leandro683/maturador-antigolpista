import { campaigns, groups, waAccounts } from '@mag/db/schema';
import type { Db } from '@mag/db';
import type { FakeEngine } from '@mag/wa-engine/fake';

let n = 0;

/** telefone de teste (padrão fictício) do participante `i` */
export const phone = (i: number) => `55119999900${String(i + 10).padStart(2, '0')}`;

/** Conta conectada + sessão no engine de mentira. */
export async function seedAccount(db: Db, engine: FakeEngine | null, over: Partial<typeof waAccounts.$inferInsert> = {}) {
  n += 1;
  const sessionName = `s${n}-${Math.floor(Math.random() * 1e6)}`;
  const [a] = await db
    .insert(waAccounts)
    .values({ name: `Conta ${n}`, sessionName, jid: `5511999990${String(n % 100).padStart(3, '0')}@c.us`, status: 'active', ...over })
    .returning();
  await engine?.createSession(sessionName);
  return a!;
}

/** Campanha com uma conta conectada e `count` grupos reais no engine de mentira (1 participante comum em cada). */
export async function seedCampaign(db: Db, engine: FakeEngine, count: number, antiHacker?: Record<string, unknown>) {
  const acc = await seedAccount(db, engine);
  n += 1;
  const [c] = await db
    .insert(campaigns)
    .values({ name: `Camp ${n}`, slug: `camp-w-${n}`, accountIds: [acc.id], ...(antiHacker ? { antiHacker } : {}) })
    .returning();
  const gs: { id: string; gid: string }[] = [];
  for (let i = 0; i < count; i++) {
    const { gid } = await engine.createGroup(acc.sessionName, { subject: `G${i}`, participants: [`${phone(i)}@c.us`] });
    engine.groups.get(gid)!.participants = [{ jid: `${phone(i)}@c.us`, isAdmin: false, isSuperAdmin: false }];
    const [g] = await db.insert(groups).values({ campaignId: c!.id, waAccountId: acc.id, name: `G${i}`, gid }).returning();
    gs.push({ id: g!.id, gid });
  }
  return { acc, camp: c!.id, gs };
}
