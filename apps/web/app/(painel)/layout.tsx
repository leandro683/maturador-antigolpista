import type { ReactNode } from 'react';
import { Footer } from '@/components/footer';
import { Sidebar } from '@/components/sidebar';
import { ConfirmHost } from '@/components/ui/confirm';
import { Email } from '@/components/ui/email';
import { Toaster } from '@/components/ui/toast';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Casca do painel: trilho de ícones à esquerda e a área de trabalho ao lado. */
export default async function PainelLayout({ children }: { children: ReactNode }) {
  const user = await requireAdmin(); // o middleware já barrou quem não tem cookie; aqui vale a sessão de verdade
  return (
    <>
      <div className="mag-shell">
        <Sidebar user={user.email ? <Email value={user.email} /> : undefined} />
        <div className="mag-area flex flex-col">
          <main className="flex-1">{children}</main>
          <Footer />
        </div>
      </div>
      <ConfirmHost />
      <Toaster />
    </>
  );
}
