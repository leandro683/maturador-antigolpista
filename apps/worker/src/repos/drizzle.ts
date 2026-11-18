import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { groupParticipants, groups, type Db } from '@mag/db';
import type { ParticipantsRepo, ParticipantUpsert } from './types';

/** Implementação Postgres dos participantes do grupo. */
export class DrizzleParticipantsRepo implements ParticipantsRepo {
  constructor(private readonly db: Db) {}

  async findGroupByGid(gid: string) {
    const [g] = await this.db
      .select({ id: groups.id, campaignId: groups.campaignId, waAccountId: groups.waAccountId })
      .from(groups)
      .where(eq(groups.gid, gid))
      .limit(1);
    return g ?? null;
  }

  async upsertParticipants(groupId: string, rows: ParticipantUpsert[]) {
    if (rows.length === 0) return;
    await this.db
      .insert(groupParticipants)
      .values(
        rows.map((r) => ({
          groupId,
          phone: r.phone,
          lid: r.lid,
          isAdmin: r.isAdmin ?? false,
          joinedAt: r.joinedAt ?? new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [groupParticipants.groupId, groupParticipants.phone],
        set: {
          lid: sql`coalesce(excluded.lid, ${groupParticipants.lid})`,
          joinedAt: sql`excluded.joined_at`,
          leftAt: sql`null`,
          updatedAt: sql`now()`,
        },
      });
  }

  async markLeft(groupId: string, phones: string[], at: Date) {
    if (phones.length === 0) return;
    await this.db
      .update(groupParticipants)
      .set({ leftAt: at, isAdmin: false, updatedAt: new Date() })
      .where(and(eq(groupParticipants.groupId, groupId), inArray(groupParticipants.phone, phones)));
  }

  async setAdmin(groupId: string, phones: string[], isAdmin: boolean) {
    if (phones.length === 0) return;
    await this.db
      .update(groupParticipants)
      .set({ isAdmin, updatedAt: new Date() })
      .where(and(eq(groupParticipants.groupId, groupId), inArray(groupParticipants.phone, phones)));
  }

  async refreshCounters(groupId: string) {
    const [c] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        admins: sql<number>`count(*) filter (where ${groupParticipants.isAdmin})::int`,
      })
      .from(groupParticipants)
      .where(and(eq(groupParticipants.groupId, groupId), isNull(groupParticipants.leftAt)));
    await this.db
      .update(groups)
      .set({ participantsAmount: c?.total ?? 0, adminsAmount: c?.admins ?? 0, updatedAt: new Date() })
      .where(eq(groups.id, groupId));
  }
}
