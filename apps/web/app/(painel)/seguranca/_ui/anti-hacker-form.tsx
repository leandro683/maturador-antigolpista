'use client';

import { useState, useTransition, type ReactNode } from 'react';
import type { AntiHackerConfig } from '@mag/module-security';
import {
  impersonationPhotoFromFileAction,
  impersonationPhotoFromNumberAction,
  saveAntiHackerAction,
} from '../actions';
import { buttonClass } from '@/components/ui/button';
import { checkboxClass, inputClass } from '@/components/ui/form';

type Bool = {
  [K in keyof AntiHackerConfig]: AntiHackerConfig[K] extends boolean ? K : never;
}[keyof AntiHackerConfig];

const SWITCHES: { name: Bool; label: string; help?: string }[] = [
  { name: 'deleteNonAdminMessages', label: 'Apagar mensagem de quem não é admin' },
  {
    name: 'removeAuthor',
    label: 'Remover o autor do grupo',
    help: 'Também remove quem foi promovido sem autorização.',
  },
  {
    name: 'sendToAntiSpam',
    label: 'Enviar o autor ao anti-spam compartilhado',
    help: 'Além da lista desta operação, bloqueia nas operações que aderiram ao anti-spam.',
  },
  {
    name: 'protectAdmins',
    label: 'Proteger administradores',
    help: 'Desfaz promoções fora da lista e re-promove as contas da operação se forem rebaixadas.',
  },
  { name: 'revertNameDescriptionChange', label: 'Restaurar nome e descrição alterados por estranhos' },
  {
    name: 'flagSuspiciousContent',
    label: 'Com o grupo aberto, agir em mensagens suspeitas',
    help: 'Links, pix e convites (padrões abaixo).',
  },
  { name: 'removeBlockedOnJoin', label: 'Remover números bloqueados que entrarem' },
  { name: 'dryRun', label: 'Modo simulação', help: 'Registra o que faria, sem apagar nem remover ninguém.' },
];

const MODES: { value: AntiHackerConfig['impersonation']; label: string }[] = [
  { value: 'off', label: 'Desligado' },
  { value: 'review', label: 'Só revisar (não remove ninguém)' },
  { value: 'auto', label: 'Remover quem usa foto igual' },
];

const MAX_PHOTOS = 20;
// mesmos limites do serviço (security.ts): acima de ~1 MB o Next recusa o corpo antes de a ação rodar
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const IMAGE_MAX = 1024 * 1024;
const PHOTO_FAIL = 'Não consegui enviar essa imagem. Use PNG, JPG ou WebP de até 1 MB.';

type PhotoHash = { ok: true; hash: string } | { ok: false; error: string };

const lines = (s: string) =>
  s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

export function AntiHackerForm({
  campaignId,
  initial,
  antiSpamOptIn,
  ready,
}: {
  campaignId: string;
  initial: AntiHackerConfig;
  antiSpamOptIn: boolean;
  ready: boolean;
}) {
  const [v, setV] = useState(initial);
  const [optIn, setOptIn] = useState(antiSpamOptIn);
  const [patterns, setPatterns] = useState(initial.suspiciousPatterns.join('\n'));
  const [allowed, setAllowed] = useState(initial.allowedAdminNumbers.join('\n'));
  const [impNames, setImpNames] = useState(initial.impersonationNames.join('\n'));
  const [photoLabel, setPhotoLabel] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [photoNumber, setPhotoNumber] = useState('');
  const [photoMsg, setPhotoMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof AntiHackerConfig>(k: K, val: AntiHackerConfig[K]) => {
    setMsg(null);
    setV((o) => ({ ...o, [k]: val }));
  };

  const save = () =>
    start(async () => {
      const r = await saveAntiHackerAction(campaignId, {
        ...v,
        suspiciousPatterns: lines(patterns),
        allowedAdminNumbers: lines(allowed),
        impersonationNames: lines(impNames),
        alertChannels: v.alertChannels,
        antiSpamOptIn: optIn,
      });
      setMsg(r.ok ? { ok: true, text: 'Configuração salva.' } : { ok: false, text: r.error });
    });

  // shortcut: guarda só rótulo + hash (sem miniatura da foto); guardar a imagem se pedirem prévia
  const photoFrom = (get: () => Promise<PhotoHash>) => {
    const label = photoLabel.trim();
    if (!label) return setPhotoMsg({ ok: false, text: 'Escreva um rótulo para identificar a foto.' });
    setPhotoMsg(null);
    start(async () => {
      // ação que estoura (corpo grande demais, rede) rejeita: mostra o mesmo erro amigável
      const r = await get().catch(() => null);
      if (!r) return setPhotoMsg({ ok: false, text: PHOTO_FAIL });
      if (!r.ok) return setPhotoMsg({ ok: false, text: r.error });
      if (v.impersonationPhotos.some((p) => p.hash === r.hash))
        return setPhotoMsg({ ok: false, text: 'Essa foto já está na lista.' });
      setMsg(null);
      setV((o) => ({ ...o, impersonationPhotos: [...o.impersonationPhotos, { label, hash: r.hash }] }));
      setPhotoLabel('');
      setPhotoNumber('');
      setPhotoFile(null);
      setFileKey((k) => k + 1);
      setPhotoMsg({ ok: true, text: 'Foto adicionada. Clique em Salvar para aplicar.' });
    });
  };

  const fromFile = () =>
    photoFrom(async () => {
      if (!photoFile) return { ok: false, error: 'Escolha uma imagem.' };
      if (!IMAGE_TYPES.includes(photoFile.type)) return { ok: false, error: 'Use uma imagem PNG, JPG ou WebP.' };
      if (photoFile.size > IMAGE_MAX) return { ok: false, error: 'A imagem passa de 1 MB.' };
      const f = new FormData();
      f.append('file', photoFile);
      return impersonationPhotoFromFileAction(f);
    });

  const fromNumber = () => photoFrom(() => impersonationPhotoFromNumberAction(campaignId, photoNumber));

  return (
    <div className="space-y-5">
      <Row
        label="Ativar anti-golpista"
        help={ready ? undefined : 'Ative uma conta espiã e cadastre os números administrativos para ligar.'}
      >
        <input
          type="checkbox"
          role="switch"
          className={checkboxClass}
          aria-label="Ativar anti-golpista"
          checked={v.enabled}
          disabled={!ready && !v.enabled}
          onChange={(e) => set('enabled', e.target.checked)}
        />
      </Row>
      <fieldset
        className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-card disabled:opacity-60"
        disabled={!v.enabled}
      >
        <legend className="px-1 text-sm font-semibold text-fg">Ao detectar</legend>
        {SWITCHES.map((s) => (
          <Row key={s.name} label={s.label} help={s.help}>
            <input
              type="checkbox"
              role="switch"
              className={checkboxClass}
              aria-label={s.label}
              checked={Boolean(v[s.name])}
              onChange={(e) => set(s.name, e.target.checked as never)}
            />
          </Row>
        ))}
        <Row
          label="Alertar no painel"
          help="Registra um alerta para promoções, contas rebaixadas e convite trocado. Os eventos aparecem na lista de incidentes desta página."
        >
          <input
            type="checkbox"
            role="switch"
            className={checkboxClass}
            aria-label="Alertar no painel"
            checked={v.alertChannels.includes('painel')}
            onChange={(e) => set('alertChannels', e.target.checked ? ['painel'] : [])}
          />
        </Row>
        <label className="block text-sm">
          <span className="block font-medium text-fg">Padrões suspeitos</span>
          <span className="block text-xs text-muted">
            Uma expressão regular por linha (sem diferenciar maiúsculas).
          </span>
          <textarea
            className={`${inputClass} mt-1 font-mono text-xs`}
            rows={5}
            value={patterns}
            onChange={(e) => setPatterns(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-fg">Outros números que podem ser admin</span>
          <span className="block text-xs text-muted">
            Além dos números administrativos, das contas da operação e dos colaboradores verificados. Um por
            linha.
          </span>
          <textarea
            className={`${inputClass} mt-1 font-mono text-xs`}
            rows={3}
            value={allowed}
            onChange={(e) => setAllowed(e.target.value)}
            placeholder="+55 45 99999-0000"
          />
        </label>
      </fieldset>
      <fieldset
        className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-card disabled:opacity-60"
        disabled={!v.enabled}
      >
        <legend className="px-1 text-sm font-semibold text-fg">Impostores</legend>
        <p className="text-xs text-muted">
          Golpistas entram no grupo com a arte oficial como foto e nomes como “Suporte”. Administradores do grupo
          e números da equipe nunca são removidos.
        </p>
        <label className="block text-sm">
          <span className="block font-medium text-fg">Quando aparecer um impostor</span>
          <select
            className={`${inputClass} mt-1`}
            value={v.impersonation}
            onChange={(e) => set('impersonation', e.target.value as AntiHackerConfig['impersonation'])}
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <Row
          label="Remover também quem tem só nome suspeito"
          help="Risco: pode remover uma pessoa real com nome como Atendimento ou Adm. Só vale no modo Remover."
        >
          <input
            type="checkbox"
            role="switch"
            className={checkboxClass}
            aria-label="Remover também quem tem só nome suspeito"
            checked={v.impersonationRemoveByName}
            disabled={v.impersonation !== 'auto'}
            onChange={(e) => set('impersonationRemoveByName', e.target.checked)}
          />
        </Row>
        <Row
          label="Analisar os grupos sozinho uma vez por dia"
          help="De madrugada, confere quem entrou nas últimas 48 horas. Remove e bloqueia o que achar, respeitando a lista oficial. Se a operação tem conta espiã, só as espiãs consultam foto e nome, em rodízio."
        >
          <input
            type="checkbox"
            role="switch"
            className={checkboxClass}
            aria-label="Analisar os grupos sozinho uma vez por dia"
            checked={v.impersonationAutoScan}
            disabled={v.impersonation !== 'auto'}
            onChange={(e) => set('impersonationAutoScan', e.target.checked)}
          />
        </Row>
        <div className="space-y-2">
          <p className="text-sm font-medium text-fg">Fotos de referência</p>
          {v.impersonationPhotos.length ? (
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {v.impersonationPhotos.map((p) => (
                <li key={p.hash} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 truncate text-fg">{p.label}</span>
                  <button
                    type="button"
                    className={buttonClass('ghost', 'sm')}
                    aria-label={`Remover foto ${p.label}`}
                    onClick={() =>
                      set(
                        'impersonationPhotos',
                        v.impersonationPhotos.filter((x) => x.hash !== p.hash),
                      )
                    }
                  >
                    remover
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">Nenhuma foto cadastrada.</p>
          )}
          {v.impersonationPhotos.length < MAX_PHOTOS ? (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <label className="block text-sm">
                <span className="block font-medium text-fg">Rótulo da foto</span>
                <input
                  className={`${inputClass} mt-1`}
                  maxLength={60}
                  value={photoLabel}
                  onChange={(e) => setPhotoLabel(e.target.value)}
                />
              </label>
              <div className="flex flex-wrap items-end gap-3">
                <label className="block text-sm">
                  <span className="block font-medium text-fg">Arquivo (PNG, JPG ou WebP, até 1 MB)</span>
                  <input
                    key={fileKey}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="mt-1 block text-sm"
                    onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                <button type="button" className={buttonClass('secondary')} disabled={pending} onClick={fromFile}>
                  Adicionar arquivo
                </button>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="block text-sm">
                  <span className="block font-medium text-fg">Ou pegar a foto de um número</span>
                  <input
                    className={`${inputClass} mt-1 w-56`}
                    value={photoNumber}
                    onChange={(e) => setPhotoNumber(e.target.value)}
                    placeholder="+55 45 99999-0000"
                  />
                </label>
                <button type="button" className={buttonClass('secondary')} disabled={pending} onClick={fromNumber}>
                  Pegar foto do número
                </button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted">Limite de {MAX_PHOTOS} fotos. Remova uma para adicionar outra.</p>
          )}
          {photoMsg && (
            <p role="status" className={`text-sm font-medium ${photoMsg.ok ? 'text-ok' : 'text-bad'}`}>
              {photoMsg.text}
            </p>
          )}
        </div>
        <label className="block text-sm">
          <span className="block font-medium text-fg">Nomes suspeitos (um por linha)</span>
          <span className="block text-xs text-muted">
            Uma expressão regular por linha (sem diferenciar maiúsculas).
          </span>
          <textarea
            className={`${inputClass} mt-1 font-mono text-xs`}
            rows={4}
            value={impNames}
            onChange={(e) => setImpNames(e.target.value)}
          />
        </label>
      </fieldset>
      <Row
        label="Participar do anti-spam compartilhado"
        help="Recusa e remove quem foi pego pelo anti-golpista em qualquer operação."
      >
        <input
          type="checkbox"
          role="switch"
          className={checkboxClass}
          aria-label="Participar do anti-spam compartilhado"
          checked={optIn}
          onChange={(e) => {
            setMsg(null);
            setOptIn(e.target.checked);
          }}
        />
      </Row>
      <div className="flex items-center gap-3">
        <button className={buttonClass('primary')} disabled={pending} onClick={save}>
          {pending ? 'Salvando…' : 'Salvar'}
        </button>
        {msg && (
          <span role="status" className={`text-sm font-medium ${msg.ok ? 'text-ok' : 'text-bad'}`}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}

function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-fg">{label}</p>
        {help && <p className="mt-0.5 text-xs text-muted">{help}</p>}
      </div>
      <div className="pt-0.5">{children}</div>
    </div>
  );
}
