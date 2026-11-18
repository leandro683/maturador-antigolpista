import { warmupPage } from '@/server/services/warmup';
import { Badge } from '@/components/ui/badge';
import { buttonClass } from '@/components/ui/button';
import { Section } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Alert, checkboxClass, Field, inputClass } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/page-header';
import type { SP } from '@/components/ui/pager';
import { Table, Td, Th } from '@/components/ui/table';
import { APPROVED_MODELS, MIN_GAP_SEC, modelInfo } from '@mag/module-warmup';
import { chipBadge } from './chip-badge';
import { ConfirmSubmit } from '@/components/confirm-submit';
import { Toggle } from './_components/toggle';
import {
  confirmChipContactsAction,
  saveModelsAction,
  saveSettingsAction,
  saveThemeAction,
  setEnabledAction,
  setParticipationAction,
  setThemeActiveAction,
} from './actions';

export const metadata = { title: 'Maturador de chips · Maturador + Anti-golpista' };
export const dynamic = 'force-dynamic';

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const usd = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
const short = (slug: string) => slug.replace(/^[^/]+\//, '').replace(/:free$/, '');
const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });

const MODES = [
  {
    value: 'queue',
    title: 'Por fila (roteiro)',
    tag: 'Recomendado para IA grátis',
    text: 'A IA escreve de uma vez uma conversa curta entre os dois chips do par, e o sistema envia as falas alternando os chips, com intervalos aleatórios. Gasta pouco: uma chamada de IA por conversa.',
  },
  {
    value: 'ai',
    title: 'IA respondendo de verdade',
    tag: '',
    text: 'Um chip puxa assunto e cada mensagem recebida é lida e respondida pela IA, depois do tempo de leitura e digitação. Mais natural, mas faz uma chamada de IA por mensagem e esgota a cota grátis bem mais rápido.',
  },
] as const;

const diaBr = (d: Date) => d.toLocaleDateString('sv', { timeZone: 'America/Sao_Paulo' });
/** "hoje" ou "amanhã" (em Brasília) para o fim da pausa, que é sempre 21:00 de Brasília. */
const voltaQuando = (until: Date, now: Date) => (diaBr(until) === diaBr(now) ? 'hoje' : 'amanhã');

const PAUSE_TEXT: Record<string, string> = {
  teto: 'Pausado: teto pago do dia atingido',
  cota: 'Pausado: cota gratuita esgotada',
  nenhum: 'Pausado: nenhum modelo respondeu',
};

/** Par de campos mín./máx. numa linha. */
function Range({ label, a, b, unit }: { label: string; a: [string, number]; b: [string, number]; unit: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
      <Field label={`${label} mínimo (${unit})`}>
        <input type="text" inputMode="decimal" name={a[0]} defaultValue={a[1]} required className={inputClass} />
      </Field>
      <Field label={`${label} máximo (${unit})`}>
        <input type="text" inputMode="decimal" name={b[0]} defaultValue={b[1]} required className={inputClass} />
      </Field>
    </div>
  );
}

/** Maturador de chips: pares de chips conversando sozinhos. Desligado por padrão; só dono/admin. */
export default async function MaturadorPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, one(v)]));
  const { settings: s, llmReady, chips, pairs, messages, themes, paidToday, pairsTotal, pairsReady, outside, last } = await warmupPage();
  const paused =
    s.pausedUntil && s.pausedUntil.getTime() > Date.now() ? (PAUSE_TEXT[s.pauseReason ?? ''] ?? PAUSE_TEXT.nenhum) : null;
  const free = APPROVED_MODELS.filter((m) => m.tier !== 'pago');
  const paid = APPROVED_MODELS.filter((m) => m.tier === 'pago');
  const rows = [
    ...chips.map((c) => ({ ...c, restricted: c.status === 'restricted' })),
    ...outside.map((o) => ({ accountId: o.accountId, name: o.name, restricted: o.status === 'restricted' })),
  ];
  const chipById = new Map(chips.map((c) => [c.accountId, c]));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Maturador de chips"
        description={
          <>
            Pares automáticos entre os chips participantes, conversando sobre temas salvos com IA gratuita (e backup pago com teto).
            <span className="mt-1 block text-xs text-muted">
              Aquecer não garante que o chip não será banido: o WhatsApp não permite automação e pode banir vários chips de uma vez.
            </span>
          </>
        }
      />
      {!llmReady && (
        <Alert tone="warn" title="Integração desligada">
          Falta a chave da OpenRouter (OPENROUTER_API_KEY) no .env do servidor. Enquanto isso, o maturador não gera conversas.
        </Alert>
      )}
      {sp.erro && <Alert tone="bad">{sp.erro}</Alert>}
      {sp.msg && <Alert tone="ok">{sp.msg}</Alert>}

      <div
        role="status"
        className={`flex flex-wrap items-center gap-3 rounded-xl p-4 ${
          !s.enabled ? 'bg-card' : paused ? 'bg-bad-soft text-bad' : last?.paid ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok'
        }`}
      >
        {!s.enabled ? (
          <>
            <Badge tone="off" dot>
              Desligado
            </Badge>
            <span className="min-w-0 flex-1 text-sm text-muted">Nenhum chip conversa enquanto estiver desligado.</span>
          </>
        ) : paused ? (
          <>
            <Badge tone="bad">Pausado</Badge>
            <span className="min-w-0 flex-1 text-sm">
              <b>{paused}.</b> O maturador volta sozinho {voltaQuando(s.pausedUntil!, new Date())} às 21:00.
            </span>
          </>
        ) : last?.paid ? (
          <>
            <Badge tone="warn" dot>
              Rodando no backup pago
            </Badge>
            <span className="min-w-0 flex-1 text-sm">
              <b>Cota gratuita esgotada hoje.</b> As conversas estão usando {modelInfo(last.model ?? '')?.name ?? last.model}. Gasto pago
              hoje: {usd.format(paidToday)} de {usd.format(s.dailyCapUsd)}. Volta aos gratuitos às 21:00.
            </span>
          </>
        ) : (
          <>
            <Badge tone="ok" dot>
              Ligado
            </Badge>
            <span className="min-w-0 flex-1 text-sm">
              <b>Gratuitos.</b> Os pares prontos estão conversando com os modelos gratuitos.
            </span>
          </>
        )}
        <form action={setEnabledAction}>
          {s.enabled ? (
            <ConfirmSubmit
              pergunta="As conversas em andamento serão encerradas e as falas pendentes descartadas. Você liga de novo quando quiser."
              titulo="Pausar todos os chips?"
              confirmar="Pausar tudo"
              className={buttonClass('danger')}
            >
              Pausar tudo
            </ConfirmSubmit>
          ) : (
            <>
              <input type="hidden" name="on" value="1" />
              <button className={buttonClass('primary')}>Ligar</button>
            </>
          )}
        </form>
      </div>

      <Section title="Modo de trabalho">
        <div className="grid gap-3 md:grid-cols-2 [&>*]:min-w-0">
          {MODES.map((m) => (
            <label
              key={m.value}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-4 has-[:checked]:border-accent has-[:checked]:bg-info-soft"
            >
              <input type="radio" form="tempo" name="mode" value={m.value} defaultChecked={s.mode === m.value} className={`${checkboxClass} mt-1`} />
              <span className="min-w-0">
                <span className="block font-semibold text-fg">
                  {m.title} {m.tag && <Badge tone="info">{m.tag}</Badge>}
                </span>
                <span className="mt-1 block text-sm text-muted">{m.text}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">O modo escolhido vale ao clicar em Salvar configuração, mais abaixo.</p>
      </Section>

      <Section
        title="Modelos de IA"
        description="Só modelos aprovados nos testes em português. Os gratuitos se revezam entre as conversas; se um falhar ou bater limite, o próximo da lista assume. Os pagos só entram quando nenhum gratuito responder."
        actions={
          <Badge tone="ok" dot>
            Gratuitos primeiro
          </Badge>
        }
      >
        <form action={saveModelsAction} noValidate className="space-y-4">
          <details className="relative">
            <summary className={`${buttonClass('secondary')} flex w-full cursor-pointer list-none items-center justify-between`}>
              <span>
                Escolher modelos gratuitos ({s.freeModels.length} selecionado{s.freeModels.length === 1 ? '' : 's'})
              </span>
              <span aria-hidden>▾</span>
            </summary>
            <div className="absolute inset-x-0 top-[calc(100%+6px)] z-10 max-h-80 overflow-auto rounded-xl bg-card p-2 shadow-card ring-1 ring-border">
              {(['principal', 'reserva'] as const).map((tier) => (
                <div key={tier}>
                  <p className="px-2.5 pb-1 pt-2 text-xs font-semibold text-muted">
                    {tier === 'principal' ? 'Gratuitos principais (rodízio)' : 'Gratuitos de reserva (se os principais falharem)'}
                  </p>
                  {free
                    .filter((m) => m.tier === tier)
                    .map((m) => (
                      <label key={m.slug} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-subtle">
                        <input
                          type="checkbox"
                          name="freeModels"
                          value={m.slug}
                          defaultChecked={s.freeModels.includes(m.slug)}
                          aria-label={`Gratuito: ${m.name}`}
                          className={checkboxClass}
                        />
                        <span className="min-w-0 flex-1 text-sm">
                          <b className="block">{m.name}</b>
                          <span className="block break-all font-mono text-xs text-muted">{m.slug}</span>
                        </span>
                        <Badge tone="ok">Grátis</Badge>
                      </label>
                    ))}
                </div>
              ))}
            </div>
          </details>
          <ol className="grid gap-2">
            {s.freeModels.map((slug, i) => (
              <li key={slug} className="flex items-center gap-2.5 rounded-lg bg-subtle px-3 py-2">
                <span className="w-5 font-heading text-lg font-bold text-accent">{i + 1}</span>
                <span className="min-w-0 flex-1 break-all font-mono text-xs">{slug}</span>
                <Badge tone={modelInfo(slug)?.tier === 'principal' ? 'info' : 'neutral'}>
                  {modelInfo(slug)?.tier === 'principal' ? 'Principal' : 'Reserva'}
                </Badge>
              </li>
            ))}
          </ol>

          <div className="space-y-3 border-t border-subtle pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-semibold text-fg">Backup pago</h3>
              <label className="flex items-center gap-2 text-sm text-muted">
                Usar quando nenhum gratuito responder
                <input type="checkbox" name="paidBackup" value="1" defaultChecked={s.paidBackup} aria-label="Backup pago ligado" className={checkboxClass} />
              </label>
            </div>
            <ol className="grid gap-2">
              {paid.map((m, i) => (
                <li key={m.slug} className="flex items-center gap-2.5 rounded-lg bg-subtle px-3 py-2">
                  <span className="w-5 font-heading text-lg font-bold text-accent">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-all font-mono text-xs">{m.slug}</span>
                    <span className="block text-xs text-muted">{m.note}</span>
                  </span>
                  <Badge tone="warn">Pago</Badge>
                  <input
                    type="checkbox"
                    name="paidModels"
                    value={m.slug}
                    defaultChecked={s.paidModels.includes(m.slug)}
                    aria-label={`Pago: ${m.name} ligado`}
                    className={checkboxClass}
                  />
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <Field label="Teto de gasto pago por dia (US$)" className="w-56">
                <input type="text" inputMode="decimal" name="dailyCapUsd" required defaultValue={s.dailyCapUsd} className={inputClass} />
              </Field>
              <Badge tone={paidToday >= s.dailyCapUsd ? 'bad' : paidToday > 0 ? 'warn' : 'neutral'}>
                Gasto pago hoje: {usd.format(paidToday)} de {usd.format(s.dailyCapUsd)}
              </Badge>
            </div>
          </div>
          <button className={buttonClass('primary')}>Salvar modelos</button>
        </form>
      </Section>

      <Section
        title="Temas"
        description="Cada conversa sorteia um tema ativo, sem repetir o último daquele par. Os temas puxam opinião e experiência pessoal e evitam placares, datas e números (a IA costuma inventar)."
        actions={
          <details className="relative">
            <summary className={`${buttonClass('secondary')} cursor-pointer list-none`}>+ Novo tema</summary>
            <form
              action={saveThemeAction}
              className="absolute right-0 top-[calc(100%+6px)] z-10 w-[min(22rem,calc(100vw-2rem))] space-y-3 rounded-xl bg-card p-4 shadow-card ring-1 ring-border"
            >
              <Field label="Nome do tema">
                <input name="name" required maxLength={80} className={inputClass} />
              </Field>
              <Field label="O que pode falar">
                <textarea name="allowed" required rows={3} maxLength={1000} className={inputClass} />
              </Field>
              <button className={buttonClass('primary', 'sm')}>Salvar tema</button>
            </form>
          </details>
        }
      >
        <p className="mb-3 text-xs text-muted">
          <b>Nunca falam (vale para todos os temas):</b> links, vendas, preço, dinheiro, Pix, política, religião, telefones, e-mails,
          propaganda, palavrões e temas sensíveis da Meta (saúde, sexo, drogas, armas, apostas, crédito, aparência).
        </p>
        <ul className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          {themes.map((t) => (
            <li key={t.id} className={`rounded-lg border border-border p-3 ${t.active ? '' : 'opacity-60'}`}>
              <div className="flex items-center justify-between gap-2">
                <b className="min-w-0 break-words">{t.name}</b>
                <span className="flex items-center gap-2">
                  {!t.active && <Badge tone="off">Desligado</Badge>}
                  <Toggle action={setThemeActiveAction} fields={{ id: t.id, on: t.active ? '0' : '1' }} on={t.active} label={`Tema ${t.name} ativo`} />
                </span>
              </div>
              <p className="mt-1 text-xs text-muted">Pode falar: {t.allowed}</p>
              <details className="mt-2">
                <summary className="cursor-pointer text-sm font-semibold text-accent">Editar</summary>
                <form action={saveThemeAction} className="mt-2 space-y-2">
                  <input type="hidden" name="id" value={t.id} />
                  <Field label="Nome do tema">
                    <input name="name" required maxLength={80} defaultValue={t.name} className={inputClass} />
                  </Field>
                  <Field label={`O que pode falar em ${t.name}`}>
                    <textarea name="allowed" required rows={3} maxLength={1000} defaultValue={t.allowed} className={inputClass} />
                  </Field>
                  <button className={buttonClass('secondary', 'sm')}>Salvar tema</button>
                </form>
              </details>
            </li>
          ))}
        </ul>
      </Section>

      <form id="tempo" action={saveSettingsAction} noValidate>
        <Section title="Segurança de tempo" description={`Nenhuma configuração desce de ${MIN_GAP_SEC} s entre duas falas.`}>
          <div className="grid gap-3 md:grid-cols-2 [&>*]:min-w-0">
            <Range label="Intervalo" unit="s" a={['gapMinSec', s.gapMinSec]} b={['gapMaxSec', s.gapMaxSec]} />
            <Range label="Pausa entre conversas" unit="min" a={['pauseMinMin', s.pauseMinMin]} b={['pauseMaxMin', s.pauseMaxMin]} />
            <Range label="Falas por conversa" unit="falas" a={['turnsMin', s.turnsMin]} b={['turnsMax', s.turnsMax]} />
            <Field label="Velocidade de digitação (caracteres por segundo)">
              <input type="text" inputMode="decimal" name="typingCps" required defaultValue={s.typingCps} className={inputClass} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
              <Field label="Janela: início (hora)" hint="De 0 a 23. Vazio = 24 h.">
                <input type="text" inputMode="numeric" name="windowStart" defaultValue={s.windowStart ?? ''} className={inputClass} />
              </Field>
              <Field label="Janela: fim (hora)" hint="De 0 a 23. Vazio = 24 h.">
                <input type="text" inputMode="numeric" name="windowEnd" defaultValue={s.windowEnd ?? ''} className={inputClass} />
              </Field>
            </div>
            <Field label="Conversas ao mesmo tempo" hint="Padrão 3. Um chip fala em uma conversa por vez.">
              <input type="text" inputMode="numeric" name="activeCap" required defaultValue={s.activeCap} className={inputClass} />
            </Field>
          </div>
          <button className={`${buttonClass('primary')} mt-4`}>Salvar configuração</button>
        </Section>
      </form>

      <Section title="Chips" description="Só contas conectadas e sem restrição podem participar.">
        {rows.length === 0 ? (
          <EmptyState title="Nenhuma conta ainda" description="Conecte contas de WhatsApp para usar no maturador." compact />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Participa</Th>
                <Th>Chip</Th>
                <Th>Situação</Th>
                <Th>Contatos salvos</Th>
                <Th>Subida</Th>
                <Th>Falas hoje / meta</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const chip = chipById.get(c.accountId);
                const on = !!chip?.active;
                const b = chip ? chipBadge(chip) : null;
                return (
                  <tr key={c.accountId}>
                    <Td>
                      <Toggle
                        action={setParticipationAction}
                        fields={{ accountId: c.accountId, on: on ? '0' : '1' }}
                        on={on}
                        label={`${c.name} participa`}
                        disabled={c.restricted}
                      />
                    </Td>
                    <Td className="font-semibold">{c.name}</Td>
                    <Td>
                      {c.restricted ? (
                        <Badge tone="bad">Restrito — não participa</Badge>
                      ) : b ? (
                        <Badge tone={b.tone} dot={b.dot}>
                          {b.text}
                        </Badge>
                      ) : (
                        <Badge tone="off">Fora do maturador</Badge>
                      )}
                    </Td>
                    <Td>
                      {on && chip ? (
                        chip.contactsConfirmed ? (
                          <Badge tone="ok">Salvos</Badge>
                        ) : (
                          <form action={confirmChipContactsAction}>
                            <input type="hidden" name="accountId" value={c.accountId} />
                            <button className={buttonClass('secondary', 'sm')} title="Salvei neste aparelho o número de todos os outros chips">
                              Salvei os números
                            </button>
                            {chip.hadConfirmed && <p className="mt-1 text-xs text-muted">Entrou chip novo: salve o número dele neste aparelho.</p>}
                          </form>
                        )
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td className="text-xs text-muted">
                      {on && chip
                        ? `Dia ${chip.day} · meta ${chip.goal} falas, ${chip.partnerLimit === Infinity ? 'todos os' : chip.partnerLimit} parceiros`
                        : '—'}
                    </Td>
                    <Td>
                      {on && chip ? (
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-subtle">
                            <div className="h-full bg-accent" style={{ width: `${Math.min(100, Math.round((chip.sentToday / chip.goal) * 100))}%` }} />
                          </div>
                          <span className="whitespace-nowrap text-xs text-muted">
                            {chip.sentToday} / {chip.goal}
                          </span>
                        </div>
                      ) : (
                        '—'
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <p className="mt-3 text-xs text-muted">
          &quot;Salvei os números&quot; = você salvou neste aparelho o número de todos os outros chips: um clique por chip, em vez de por par.
        </p>
      </Section>

      <Section
        title="Pares automáticos"
        description="Criados sozinhos entre todos os participantes. Conversam em rodízio, respeitando a meta e o limite de parceiros por dia de cada chip."
        actions={<Badge tone="info">{`${pairsTotal} ${pairsTotal === 1 ? 'par' : 'pares'} · ${pairsReady} ${pairsReady === 1 ? 'pronto' : 'prontos'}`}</Badge>}
      >
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-accent">Ver todos os pares</summary>
          {pairs.length === 0 ? (
            <p className="mt-2 text-sm text-muted">Nenhum par ainda: marque pelo menos dois chips em &quot;Participa&quot;.</p>
          ) : (
            <ul className="mt-2 columns-1 text-sm text-muted sm:columns-2">
              {pairs.map((p) => (
                <li key={p.id} className="break-words">
                  {p.nameA} ↔ {p.nameB}
                  {!p.active && ' · desligado'}
                </li>
              ))}
            </ul>
          )}
        </details>
      </Section>

      <Section title="Últimas mensagens" description="As 30 mais recentes entre os chips (horário de Brasília).">
        {messages.length === 0 ? (
          <EmptyState title="Nenhuma mensagem ainda" description="Aparecem aqui quando os pares começarem a conversar." compact />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Hora</Th>
                <Th>De</Th>
                <Th>Para</Th>
                <Th>Tema</Th>
                <Th>Modelo</Th>
                <Th>Texto</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr key={m.id}>
                  <Td className="whitespace-nowrap">{hora.format(m.at)}</Td>
                  <Td>{m.from}</Td>
                  <Td>{m.to}</Td>
                  <Td>{m.theme ?? '—'}</Td>
                  <Td className="font-mono text-xs">
                    {m.model ? short(m.model) : '—'} {m.paid && <Badge tone="warn">pago</Badge>}
                  </Td>
                  <Td className="min-w-48 break-words">{m.text}</Td>
                  <Td>
                    <Badge tone={m.status === 'sent' ? 'ok' : 'bad'}>{m.status === 'sent' ? 'Enviada' : 'Falhou'}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </div>
  );
}
