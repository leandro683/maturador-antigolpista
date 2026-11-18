import 'server-only';
import { createAccountsService } from '@mag/accounts';
import type { WaEngine } from '@mag/wa-engine';
import { requireAdmin } from '@/lib/auth';
import { serverDb } from '@/server/db';
import { serverEngine } from '@/server/engine';

export const NO_ENGINE_MESSAGE = 'WhatsApp não configurado: defina WAHA_URL (ou WA_FAKE_ENGINE=1 para demonstração).';

// sem motor, listar/criar/remover continuam valendo (só banco); o que fala com o WhatsApp falha com o aviso acima
const NO_ENGINE = new Proxy(
  {},
  {
    get: (_t, prop) =>
      prop === 'qrCycle'
        ? undefined
        : async () => {
            throw new Error(NO_ENGINE_MESSAGE);
          },
  },
) as WaEngine;

/** Serviço de contas do painel. Exige sessão de admin antes de qualquer acesso (redireciona para /login). */
export async function accountsService() {
  await requireAdmin();
  return createAccountsService(serverDb(), serverEngine() ?? NO_ENGINE);
}
