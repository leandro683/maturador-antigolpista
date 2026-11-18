/**
 * Manifest de módulo (`modules/<nome>/manifest.ts`). O web gera a sidebar a partir de todos os
 * manifests (scripts/gen-modules.mjs) — nenhuma sessão edita arquivo de menu compartilhado.
 */
export type TeamRole = 'owner' | 'admin' | 'operator' | 'viewer';

export const ROLE_RANK: Record<TeamRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

export function hasRole(role: TeamRole | null | undefined, min: TeamRole): boolean {
  return role != null && ROLE_RANK[role] >= ROLE_RANK[min];
}

export type NavItem = { label: string; href: string; minRole?: TeamRole };

export type ModuleManifest = {
  id: string;
  label: string;
  /** menor = mais acima */
  order: number;
  /** grupo de 1º nível */
  section?: string;
  minRole?: TeamRole;
  items: NavItem[];
  /** módulos de exemplo/rascunho não aparecem na nav */
  hidden?: boolean;
};

export function defineModule(m: ModuleManifest): ModuleManifest {
  if (!/^[a-z0-9_-]+$/.test(m.id)) throw new Error(`id de módulo inválido: ${m.id}`);
  return m;
}

export type NavSection = { id: string; label: string; items: NavItem[] };

/** Sidebar 2 níveis: módulo → itens, filtrado por papel e ordenado. Módulos com o mesmo `section` viram 1 grupo
 * (id/label do 1º na ordem; itens na ordem dos módulos, sem href repetido). */
export function buildNav(manifests: ModuleManifest[], role: TeamRole | null): NavSection[] {
  const out: NavSection[] = [];
  const bySection = new Map<string, NavSection>();
  const sorted = manifests
    .filter((m) => !m.hidden && hasRole(role, m.minRole ?? 'viewer'))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, 'pt-BR'));
  for (const m of sorted) {
    const items = m.items.filter((i) => hasRole(role, i.minRole ?? 'viewer'));
    const key = m.section ? `s:${m.section}` : `m:${m.id}`;
    let sec = bySection.get(key);
    if (!sec) {
      sec = { id: m.id, label: m.label, items: [] };
      bySection.set(key, sec);
      out.push(sec);
    }
    for (const i of items) if (!sec.items.some((x) => x.href === i.href)) sec.items.push(i);
  }
  return out.filter((s) => s.items.length > 0);
}
