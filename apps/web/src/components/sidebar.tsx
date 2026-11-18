'use client';

import { Ban, Flame, LayoutGrid, ShieldCheck, Smartphone, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { sair } from '../../app/login/actions';

const ITENS: { label: string; href: string; icon: LucideIcon }[] = [
  { label: 'Contas', href: '/contas', icon: Smartphone },
  { label: 'Operações', href: '/grupos', icon: LayoutGrid },
  { label: 'Maturador', href: '/maturador', icon: Flame },
  { label: 'Anti-golpista', href: '/seguranca', icon: ShieldCheck },
  { label: 'Bloqueados', href: '/bloqueados', icon: Ban },
];

/**
 * Trilho de ícones (estilos `.mag-*` em globals.css): um ícone por tela, o rótulo abre por cima no hover/foco;
 * no pé, quem está logado + Sair. ≤ 860px vira barra no topo.
 */
export function Sidebar({ user }: { user?: ReactNode }) {
  const path = usePathname();
  return (
    <aside className="mag-trilho">
      <Link href="/contas" className="mag-marca" aria-label="Maturador + Anti-golpista — início">
        <ShieldCheck size={26} aria-hidden />
        <span className="mag-marca-texto">Maturador + Anti-golpista</span>
      </Link>
      <nav className="mag-nav" aria-label="Navegação principal">
        {ITENS.map(({ label, href, icon: Icone }) => (
          <Link
            key={href}
            href={href}
            className="mag-item"
            aria-current={path === href || path.startsWith(`${href}/`) ? 'page' : undefined}
            title={label}
          >
            <Icone size={22} aria-hidden />
            <span className="mag-rotulo">{label}</span>
          </Link>
        ))}
      </nav>
      <form action={sair} className="mag-pe">
        {user && <span>{user}</span>}
        <button type="submit">Sair</button>
      </form>
    </aside>
  );
}
