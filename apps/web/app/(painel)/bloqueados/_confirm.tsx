'use client';

import type { ComponentProps } from 'react';
import { BlacklistManager } from '@mag/module-blacklist/ui';
import { confirmar } from '@/components/ui/confirm';

/**
 * A UI do módulo não importa de apps/web: a página (server) passa as server actions e este wrapper (client) soma o
 * diálogo de confirmação do painel em `actions.ask`.
 */
export function BlacklistWithConfirm(p: ComponentProps<typeof BlacklistManager>) {
  return <BlacklistManager {...p} actions={{ ...p.actions, ask: confirmar }} />;
}
