import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AntiHackerForm } from '../../../seguranca/_ui/anti-hacker-form';
import { ScanPanel } from '../../../seguranca/_ui/scan';
import { Badge } from '@/components/ui/badge';
import { Section } from '@/components/ui/card';
import { Stat } from '@/components/ui/stat';
import { fmtDateTime } from '@/lib/format';
import { campaignSecurityPage } from '@/server/services/security';
import { operacaoOuNull } from '../_operacao';

export const metadata = { title: 'Anti-golpista · Maturador + Anti-golpista' };
export const dynamic = 'force-dynamic';

const ONLINE = new Set(['active', 'connected']);

/** Anti-golpista da operação: status (espiã? admins?) + configuração completa + análise dos grupos. */
export default async function AntiGolpistaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await operacaoOuNull(id))) notFound(); // também exige sessão de admin
  const s = await campaignSecurityPage(id);
  if (!s) notFound();
  const r = s.readiness;

  return (
    <div className="space-y-5">
      <p className="max-w-2xl text-sm text-muted">
        Com o grupo fechado, mensagem de quem não está na lista é apagada e o autor removido e bloqueado. Também desfaz
        promoções e mudanças de nome feitas por estranhos.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="sec-status">
        <Stat
          label="Conta espiã"
          value={
            r.spyAccounts ? (
              <Badge tone={r.spyActive ? 'ok' : 'warn'} dot={r.spyActive}>
                {r.spyActive ? 'ativa' : 'desconectada'}
              </Badge>
            ) : (
              <Badge tone="warn">nenhuma</Badge>
            )
          }
        />
        <Stat
          label="Números administrativos"
          value={
            <Badge tone={r.adminNumbers ? 'ok' : 'warn'}>
              {r.adminNumbers ? `${r.adminNumbers} cadastrados` : 'nenhum'}
            </Badge>
          }
        />
        <Stat
          label="Incidentes em aberto"
          value={
            <Link
              href={`/seguranca?campanha=${id}&abertos=1`}
              className={s.open ? 'text-bad hover:underline' : 'text-fg hover:underline'}
            >
              {s.open}
            </Link>
          }
          hint="Clique para ver em Anti-golpista"
        />
      </div>

      {!r.ok && (
        <div role="alert" className="rounded-lg border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn">
          <p className="font-semibold">Ative uma conta espiã e cadastre os números administrativos.</p>
          <ul className="mt-1 list-disc pl-5 text-fg/90">
            {r.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-fg/90">
            Conta espiã: em{' '}
            <Link href="/contas" className="font-medium underline">
              Contas
            </Link>{' '}
            marque o papel “espiã” e escolha o chip em{' '}
            <Link href={`/grupos/${id}`} className="font-medium underline">
              Chips da operação
            </Link>
            . Números da equipe em{' '}
            <Link href="/bloqueados?aba=admin" className="font-medium underline">
              Números administrativos
            </Link>
            .
          </p>
        </div>
      )}

      <AntiHackerForm campaignId={id} initial={s.config} antiSpamOptIn={s.antiSpamOptIn} ready={r.ok} />

      <ScanPanel
        campaigns={[]}
        fixedCampaignId={id}
        fixedImpersonation={s.config.impersonation}
        fixedEnabled={s.config.enabled}
        adminCount={r.adminNumbers}
        scans={s.scans.map((x) => ({ ...x, campaign: null, createdAt: fmtDateTime(x.createdAt) }))}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Chips da operação" description="Sempre podem ser admin. Agem no grupo quando há incidente.">
          <ul className="space-y-1.5 text-sm">
            {s.accounts.length ? (
              s.accounts.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-fg">{a.name}</span>
                  <span className="flex gap-1">
                    <Badge tone={a.role === 'spy' ? 'ok' : 'neutral'}>{a.role === 'spy' ? 'espiã' : 'normal'}</Badge>
                    <Badge tone={ONLINE.has(a.status) ? 'ok' : 'off'}>{ONLINE.has(a.status) ? 'online' : a.status}</Badge>
                  </span>
                </li>
              ))
            ) : (
              <li className="text-muted">Nenhum chip na operação.</li>
            )}
          </ul>
        </Section>
        <Section
          title="Números administrativos"
          description="Nunca são removidos nem bloqueados."
          actions={
            <Link href="/bloqueados?aba=admin" className="text-sm text-accent hover:underline">
              Gerenciar
            </Link>
          }
        >
          <ul className="space-y-1.5 text-sm" data-testid="admin-numbers">
            {s.admins.slice(0, 12).map((a) => (
              <li key={a.id} className="flex justify-between gap-3">
                <span className="min-w-0 truncate text-fg">{a.label ?? '—'}</span>
                <span className="font-mono text-xs text-muted">{a.number}</span>
              </li>
            ))}
            {s.admins.length > 12 && <li className="text-xs text-muted">+{s.admins.length - 12}</li>}
            {!s.admins.length && <li className="text-muted">Nenhum cadastrado.</li>}
          </ul>
        </Section>
      </div>
    </div>
  );
}
