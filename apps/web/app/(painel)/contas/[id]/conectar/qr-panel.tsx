'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { conectarContaAction } from '../../actions';
import { buttonClass } from '@/components/ui/button';
import { cardClass } from '@/components/ui/card';
import { Alert } from '@/components/ui/form';
import { cn } from '@/lib/cn';

type Estado = { connected: boolean; image: string | null; expired: boolean };

const POLL_MS = 3000;

/** QR grande; consulta /contas/[id]/qr a cada 3 s (o QR do WhatsApp gira a cada ~20 s) e avisa quando conectar. */
export function QrPanel({ id }: { id: string }) {
  const router = useRouter();
  const [v, setV] = useState<Estado>({ connected: false, image: null, expired: false });
  const [erro, setErro] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const parado = v.connected || v.expired;

  useEffect(() => {
    if (parado) return;
    let vivo = true;
    const tick = async () => {
      try {
        const r = await fetch(`/contas/${id}/qr`, { cache: 'no-store' });
        if (!vivo) return;
        if (r.status === 410) return setV({ connected: false, image: null, expired: true });
        if (r.status === 401 || r.status === 404) return setErro('Sessão encerrada ou conta inexistente. Volte para Contas.');
        if (!r.ok) return setErro('QR ainda não disponível. Tentando de novo…');
        const j = (await r.json()) as { connected: boolean; image?: string };
        setErro(null);
        setV({ connected: j.connected, image: j.image ?? null, expired: false });
      } catch {
        if (vivo) setErro('Sem resposta do servidor. Tentando de novo…');
      }
    };
    const t = setInterval(tick, POLL_MS);
    void tick();
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [id, parado]);

  useEffect(() => {
    if (!v.connected) return;
    const t = setTimeout(() => router.push('/contas'), 1500);
    return () => clearTimeout(t);
  }, [v.connected, router]);

  const novoCiclo = () =>
    start(async () => {
      const r = await conectarContaAction(id);
      if (!r.ok) return setErro(r.error);
      setErro(null);
      setV({ connected: false, image: null, expired: false });
    });

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[auto_1fr]">
      <div className={cn(cardClass, 'flex flex-col items-center gap-3 p-5')}>
        <div
          className={cn(
            'flex aspect-square w-80 max-w-full items-center justify-center rounded-xl border border-border p-3',
            // o QR precisa de fundo branco nos dois temas para a câmera ler
            v.image && !v.connected ? 'bg-white' : 'bg-subtle',
          )}
        >
          {v.connected ? (
            <p className="text-center text-lg font-medium text-ok">Conectada! ✓</p>
          ) : v.image ? (
            // data URL do WAHA (muda a cada ~20 s): sem next/image
            <img src={v.image} alt="QR code para conectar o WhatsApp" className="size-full" data-testid="qr-image" />
          ) : v.expired ? (
            <p className="px-6 text-center text-sm text-muted">QR code expirado.</p>
          ) : (
            <p className="text-sm text-muted">Gerando QR code…</p>
          )}
        </div>
      </div>

      <div className={cn(cardClass, 'max-w-prose p-5')}>
        <h2 className="text-base font-semibold">Como conectar</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
          <li>Abra o WhatsApp no celular do número que será usado.</li>
          <li>
            Toque em <strong>Mais opções ⋮</strong> (Android) ou <strong>Configurações</strong> (iPhone) →{' '}
            <strong>Dispositivos conectados</strong> → <strong>Conectar dispositivo</strong>.
          </li>
          <li>Aponte a câmera para o QR code ao lado. Ele muda sozinho a cada poucos segundos.</li>
          <li>Mantenha o celular com internet até a conta aparecer como conectada.</li>
        </ol>
        {v.expired && (
          <Alert tone="warn" className="mt-4">
            Os QR codes expiraram sem leitura. Gere um novo ciclo para tentar de novo.
          </Alert>
        )}
        {erro && (
          <Alert tone="bad" className="mt-4">
            {erro}
          </Alert>
        )}
        <div className="mt-6 flex flex-wrap gap-2">
          {!v.connected && (
            <button type="button" className={buttonClass('primary')} onClick={novoCiclo} disabled={pending}>
              {pending ? 'Gerando…' : 'Gerar novo ciclo de QR'}
            </button>
          )}
          <Link href="/contas" className={buttonClass('secondary')}>
            Voltar para Contas
          </Link>
        </div>
      </div>
    </div>
  );
}
