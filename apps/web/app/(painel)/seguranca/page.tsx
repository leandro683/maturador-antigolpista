import Link from 'next/link';
import { INCIDENT_KINDS, KIND_LABEL, readAntiHacker, STATUS_LABEL } from '@mag/module-security';
import { securityPage } from '@/server/services/security';
import { btnParts as btn } from '@/components/ui/button';
import { Section } from '@/components/ui/card';
import { inputClass as inputCls } from '@/components/ui/form';
import { Stat } from '@/components/ui/stat';
import { nf } from '@/lib/format';
import { PageHeader } from '@/components/ui/page-header';
import { Pager } from '@/components/ui/pager';
import { SelectSearch } from '@/components/ui/select-search';
import { GlobalSecuritySettings } from './_ui/global-settings';
import { ExportButton, IncidentsTable, OptInToggle, type IncidentView } from './_ui/incidents';
import { ScanPanel, type ScanRowView } from './_ui/scan';

export const metadata = { title: 'Anti-golpista' };
export const dynamic = 'force-dynamic';

const fmt = (d: Date) =>
  d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium' });

const REASON: Record<string, string> = {
  'closed-group': 'grupo fechado',
  suspicious: 'conteúdo suspeito',
};

const FINDING_STATUS = new Set(['open', 'failed']);

/** Observação curta do achado da análise p/ a coluna Tipo. */
function findingDetail(kind: string, d: Record<string, unknown> | null | undefined): string | undefined {
  if (!d) return undefined;
  if (kind === 'scan.non-admin-message')
    return typeof d.body === 'string' && d.body ? `“${d.body}”` : d.hasMedia ? 'mídia sem texto' : undefined;
  if (kind === 'scan.blacklisted')
    return d.admin ? 'bloqueado e é admin do grupo' : 'está na lista de bloqueados';
  if (kind === 'scan.unknown-admin') return 'admin que não é da equipe nem colaborador';
  if (kind === 'scan.impersonator') {
    const why = d.reason === 'photo' ? `Foto igual a «${d.matched}»` : `Nome suspeito: «${d.matched}»`;
    return typeof d.profileName === 'string' && d.profileName ? `${why} · perfil: ${d.profileName}` : why;
  }
  return undefined;
}

/** Log de incidentes do anti-hacker (filtros, ação tomada, ignorar/reverter, export) + anti-spam compartilhado. */
export default async function SegurancaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const p = await securityPage(sp);
  const f = p.filter;
  const protectedCount = p.campaigns.filter((c) => readAntiHacker(c.antiHacker).enabled).length;
  const optedIn = p.campaigns.filter((c) => p.optIns.get(c.id)).length;
  const pages = Math.max(1, Math.ceil(p.list.total / 25));

  const rows: IncidentView[] = p.list.rows.map((r) => ({
    id: r.id,
    createdAt: fmt(r.createdAt),
    kind: r.kind,
    kindLabel: KIND_LABEL[r.kind] ?? r.kind,
    status: r.status,
    statusLabel: STATUS_LABEL[r.status] ?? r.status,
    severity: r.severity,
    who: r.phone ?? (r.lid ? `${r.lid}@lid` : '—'),
    actor: r.actor,
    campaign: r.campaignName,
    group: r.groupName ?? r.gid,
    actions: r.actions,
    resolved: !!r.resolvedAt,
    reason: REASON[String(r.details?.reason ?? '')],
    finding: r.kind.startsWith('scan.') && FINDING_STATUS.has(r.status),
    isMessage: r.kind === 'scan.non-admin-message' && !!r.messageId,
    detail: findingDetail(r.kind, r.details),
  }));
  const names = new Map(p.campaigns.map((c) => [c.id, c.name]));
  const scans: ScanRowView[] = p.scans.map((s) => ({
    ...s,
    campaign: s.campaignId ? (names.get(s.campaignId) ?? null) : null,
    createdAt: fmt(s.createdAt),
  }));

  return (
    <section className="space-y-6">
      <PageHeader
        title="Anti-golpista"
        description="Tudo que o anti-golpista fez nos grupos: mensagens apagadas, invasores removidos, promoções desfeitas e nomes restaurados. Também os achados da análise manual dos grupos, esperando a sua decisão."
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Incidentes em aberto" value={nf.format(p.open)} />
        <Stat
          label="Operações protegidas"
          value={`${nf.format(protectedCount)}/${nf.format(p.campaigns.length)}`}
          hint="anti-golpista ligado"
        />
        <Stat
          label="Números administrativos"
          value={nf.format(p.adminCount)}
          hint={p.adminCount ? 'nunca removidos' : 'cadastre antes de ligar o anti-golpista'}
        />
        <Stat label="No anti-spam compartilhado" value={nf.format(optedIn)} hint="operações com adesão" />
      </div>

      <ScanPanel
        campaigns={p.campaigns.map((c) => {
          const ah = readAntiHacker(c.antiHacker);
          return { id: c.id, name: c.name, impersonation: ah.impersonation, enabled: ah.enabled };
        })}
        scans={scans}
        adminCount={p.adminCount}
      />

      <form
        method="get"
        className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4 shadow-card"
        aria-label="Filtros"
      >
        {f.raw.analise && <input type="hidden" name="analise" value={f.raw.analise} />}
        <label className="block w-full text-xs font-medium text-muted sm:w-64">
          <span className="mb-1 block">Operação</span>
          <SelectSearch
            name="campanha"
            defaultValue={f.raw.campanha}
            options={p.campaigns.map((c) => ({ value: c.id, label: c.name }))}
            emptyOption="Todas"
            placeholder="Buscar operação…"
          />
        </label>
        <label className="text-xs font-medium text-muted">
          Tipo
          <select name="tipo" defaultValue={f.raw.tipo} className={`${inputCls} mt-1`}>
            <option value="">Todos</option>
            {INCIDENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-muted">
          De
          <input type="date" name="de" defaultValue={f.raw.de} className={`${inputCls} mt-1`} />
        </label>
        <label className="text-xs font-medium text-muted">
          Até
          <input type="date" name="ate" defaultValue={f.raw.ate} className={`${inputCls} mt-1`} />
        </label>
        <label className="flex h-8 items-center gap-1.5 text-sm text-fg">
          <input
            type="checkbox"
            className="size-4 accent-[var(--color-accent)]"
            name="abertos"
            value="1"
            defaultChecked={f.raw.abertos === '1'}
          />{' '}
          Só em aberto
        </label>
        <button className={`${btn.base} ${btn.primary}`}>Filtrar</button>
        <Link href="/seguranca" className={`${btn.base} ${btn.ghost}`}>
          Limpar
        </Link>
        <span className="ml-auto">
          <ExportButton filter={f.raw} />
        </span>
      </form>

      <div className="space-y-3">
        <p className="text-sm text-muted">
          {nf.format(p.list.total)} incidente(s)
          {f.raw.analise && (
            <>
              {' '}
              da análise selecionada ·{' '}
              <Link href="/seguranca" className="font-medium text-accent hover:underline">
                ver todos
              </Link>
            </>
          )}
        </p>
        {!p.engineReady && rows.some((r) => r.finding) && (
          <p
            role="alert"
            className="rounded-lg border border-warn/30 bg-warn-soft px-4 py-2.5 text-sm text-warn"
          >
            O WhatsApp não está configurado neste servidor: “Ignorar” funciona, mas remover e apagar ficam
            indisponíveis.
          </p>
        )}
        <IncidentsTable rows={rows} />
        {pages > 1 && (
          <Pager
            base="/seguranca"
            sp={f.raw}
            page={f.page ?? 1}
            pageSize={25}
            total={p.list.total}
            param="pagina"
          />
        )}
      </div>

      <GlobalSecuritySettings
        initial={{
          antiSpamAssociatedOnly: p.settings.antiSpamAssociatedOnly,
          sharedBlocklistAllCampaigns: p.settings.sharedBlocklistAllCampaigns,
        }}
        updatedAt={p.settings.updatedAt ? fmt(p.settings.updatedAt) : null}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section title="Números com mais incidentes" description="Relatório por número nos filtros atuais.">
          {p.byNumber.length ? (
            <ul className="divide-y divide-border text-sm">
              {p.byNumber.slice(0, 10).map((n) => (
                <li key={n.key} className="flex justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <span className="font-mono text-xs">{n.key}</span>
                  <span className="font-medium tabular-nums">{nf.format(n.total)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Nada por aqui ainda.</p>
          )}
        </Section>
        <Section
          title="Anti-spam compartilhado"
          description={
            <>
              {p.settings.sharedBlocklistAllCampaigns
                ? 'A regra geral acima está ligada: a lista compartilhada vale para todas as operações, com ou sem adesão.'
                : 'Quem for pego pelo anti-golpista em qualquer operação é recusado e removido nas operações que aderirem.'}{' '}
              <Link href="/bloqueados" className="font-medium text-accent hover:underline">
                Ver listas
              </Link>
            </>
          }
        >
          <div className="-my-2 max-h-72 divide-y divide-border overflow-y-auto">
            {p.campaigns.map((c) => (
              <OptInToggle key={c.id} campaignId={c.id} name={c.name} enabled={!!p.optIns.get(c.id)} />
            ))}
          </div>
        </Section>
      </div>
    </section>
  );
}
