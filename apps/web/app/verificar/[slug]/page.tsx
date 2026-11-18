import { notFound } from 'next/navigation';
import { loadPublicVerifyPage } from '@/server/services/public-verify';
import { VerifyForm } from './verify-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Verificar número', robots: { index: false, follow: false } };

/**
 * Página pública (sem login) p/ qualquer pessoa conferir se um número que a abordou é da equipe.
 * Responde só "é da equipe" / "não é da equipe"; nunca mostra a lista.
 */
export default async function VerificarPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await loadPublicVerifyPage(slug);
  if (!page) notFound();
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-card sm:p-8">
        <h1 className="font-heading text-3xl font-bold uppercase leading-none text-fg">Verificar número</h1>
        <p className="mt-2 text-sm text-muted">
          {page.title}: digite o número que falou com você para saber se ele é mesmo da nossa equipe.
        </p>
        <VerifyForm slug={page.slug} />
        <p className="mt-6 text-xs text-muted">
          Nunca pedimos senhas, códigos ou pagamentos por mensagem. Na dúvida, não responda.
        </p>
      </div>
    </main>
  );
}
