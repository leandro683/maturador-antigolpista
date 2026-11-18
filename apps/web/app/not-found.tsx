import Link from 'next/link';

export const metadata = { title: 'Página não encontrada · Maturador + Anti-golpista' };

/** 404 em português (o padrão do Next sai em inglês). Não diz nada sobre o que existe ou não (página pública desligada cai aqui). */
export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-6">
      <div className="grid max-w-[420px] gap-3 text-center">
        <h1 className="font-heading text-2xl font-bold">Página não encontrada</h1>
        <p className="text-sm text-muted">O endereço não existe ou não está disponível.</p>
        <Link href="/" className="text-sm font-medium underline">
          Voltar ao início
        </Link>
      </div>
    </main>
  );
}
