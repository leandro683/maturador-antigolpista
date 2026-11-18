/** Portas de persistência do worker (implementações: memory.ts p/ teste, drizzle.ts p/ Postgres). */

export type GroupRef = { id: string; campaignId: string; waAccountId: string | null };

export type ParticipantUpsert = {
  phone: string; // E.164 quando conhecido; senão o JID cru (LID-only)
  lid: string | null;
  isAdmin?: boolean;
  joinedAt?: Date;
};

export interface ParticipantsRepo {
  findGroupByGid(gid: string): Promise<GroupRef | null>;
  upsertParticipants(groupId: string, rows: ParticipantUpsert[]): Promise<void>;
  markLeft(groupId: string, phones: string[], at: Date): Promise<void>;
  setAdmin(groupId: string, phones: string[], isAdmin: boolean): Promise<void>;
  /** recalcula groups.participants_amount/admins_amount a partir de group_participants */
  refreshCounters(groupId: string): Promise<void>;
}
