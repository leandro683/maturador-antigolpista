import { inArray, sql } from 'drizzle-orm';
import type { Db } from '@mag/db';
import { lidMap } from '@mag/db/schema';
import { ChatIdResolver, withPhoneResolution, type PhoneLidStore, type WaEngine } from '@mag/wa-engine';
import type { LidHint } from '../../../packages/wa-engine/src/waha/lid';

/** `lid_map`: cache persistente LID → telefone. */
export class DrizzleLidStore implements PhoneLidStore {
  constructor(private readonly db: Db) {}

  async get(lids: string[]) {
    if (!lids.length) return new Map<string, string>();
    const rows = await this.db
      .select({ lid: lidMap.lid, phone: lidMap.phone })
      .from(lidMap)
      .where(inArray(lidMap.lid, lids));
    return new Map(rows.map((r) => [r.lid, r.phone]));
  }

  async put(hints: LidHint[], source: string) {
    if (!hints.length) return;
    await this.db
      .insert(lidMap)
      .values(hints.map((h) => ({ lid: h.lid, phone: h.phone, source })))
      .onConflictDoUpdate({
        target: lidMap.lid,
        set: { phone: sql`excluded.phone`, source: sql`excluded.source`, updatedAt: sql`now()` },
      });
  }

  /** Telefone canônico → LID (`lid_map`). */
  async byPhone(phones: string[]) {
    const out = new Map<string, string>();
    if (!phones.length) return out;
    const rows = await this.db
      .select({ lid: lidMap.lid, phone: lidMap.phone })
      .from(lidMap)
      .where(inArray(lidMap.phone, phones));
    for (const r of rows) out.set(r.phone, r.lid);
    return out;
  }
}

/** Engine cujo envio/participante por telefone resolve o JID real (variante c/ ou s/ 9, LID conhecido). */
export function phoneResolvingEngine<T extends WaEngine>(engine: T, db: Db): T {
  return withPhoneResolution(engine, new ChatIdResolver(engine, { store: new DrizzleLidStore(db) }));
}
