import { identityOf, IdentitySet, type Identity } from './identity';
import type { GroupContextOptions, NewIncident, SecGroupContext, SecRepo } from './repo';
import { DEFAULT_SECURITY_SETTINGS, type SecuritySettings } from './settings';
import type { IncidentAction, IncidentStatus } from './tables';

/** Repo em memória p/ testes dos handlers. */
export class MemorySecRepo implements SecRepo {
  groups = new Map<string, SecGroupContext>();
  trustedByCampaign = new Map<string, Identity[]>();
  adminNumbers: Identity[] = [];
  blocked: { who: Identity; campaignId: string; name: string; toAntiSpam: boolean }[] = [];
  preBlocked = new IdentitySet();
  incidents: (NewIncident & { id: string; actions: IncidentAction[] })[] = [];
  alerts: { type: string; data: Record<string, unknown> }[] = [];
  settings: SecuritySettings = { ...DEFAULT_SECURITY_SETTINGS };
  settingsReads = 0;
  /** contas nossas de fora da campanha presentes no grupo (com "só associadas" desligado) */
  extraAccounts = new Map<string, SecGroupContext['accounts']>();
  agency: Identity[] = [];
  /** quem entrou em cada grupo e quando (`group_participants` em memória) */
  joiners: { groupId: string; who: Identity; joinedAt: Date }[] = [];
  private seq = 0;

  async groupContext(gid: string, opts: GroupContextOptions = {}) {
    const c = this.groups.get(gid);
    if (!c) return null;
    if (opts.associatedOnly !== false) return c;
    const extra = (this.extraAccounts.get(gid) ?? []).map((a) => ({ ...a, associated: false }));
    return { ...c, accounts: [...c.accounts, ...extra] };
  }
  async globalSettings() {
    this.settingsReads += 1;
    return { ...this.settings };
  }
  async agencyAccounts() {
    return [...this.agency];
  }
  async recordFinding(i: NewIncident, opts: { skipKeys?: string[] } = {}) {
    const keys = new Set([i.dedupKey, ...(opts.skipKeys ?? [])]);
    const same = (x: NewIncident) =>
      x.kind === i.kind &&
      ['open', 'failed', 'ignored'].includes(x.status) &&
      x.groupId === i.groupId &&
      ((!!i.who?.number && x.who?.number === i.who.number) || (!!i.who?.lid && x.who?.lid === i.who.lid)) &&
      (x.messageId ?? '') === (i.messageId ?? '');
    if (this.incidents.some((x) => keys.has(x.dedupKey) || same(x))) return null;
    return this.claimIncident(i);
  }
  async trusted(campaignId: string) {
    return [...this.adminNumbers, ...(this.trustedByCampaign.get(campaignId) ?? [])];
  }
  async claimIncident(i: NewIncident) {
    if (this.incidents.some((x) => x.dedupKey === i.dedupKey)) return null;
    const id = `inc-${++this.seq}`;
    this.incidents.push({ ...i, id, actions: [] });
    return id;
  }
  async finishIncident(id: string, r: { status: IncidentStatus; actions: IncidentAction[] }) {
    const x = this.incidents.find((i) => i.id === id)!;
    x.status = r.status;
    x.actions = r.actions;
  }
  async block(i: Parameters<SecRepo['block']>[0]) {
    this.blocked.push({ who: i.who, campaignId: i.campaign.id, name: i.name, toAntiSpam: i.toAntiSpam });
  }
  async isBlocked(who: Identity) {
    return this.preBlocked.has(who) || this.blocked.some((b) => new IdentitySet([b.who]).has(who));
  }
  async blockedAmong(whos: Identity[]) {
    const out: Identity[] = [];
    for (const w of whos) if (await this.isBlocked(w)) out.push(w);
    return out;
  }
  async recentJoiners(groupId: string, since: Date) {
    return new IdentitySet(this.joiners.filter((j) => j.groupId === groupId && j.joinedAt >= since).map((j) => j.who));
  }
  async alert(a: Parameters<SecRepo['alert']>[0]) {
    this.alerts.push({ type: a.type, data: a.data });
  }
}

export { identityOf };
