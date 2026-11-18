'use client';

/** Erro inesperado em português (o padrão do Next sai em inglês). Nada do erro é mostrado ao usuário. */
export default function ErroInesperado({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-6">
      <div className="grid max-w-[420px] gap-3 text-center">
        <h1 className="font-heading text-2xl font-bold">Algo deu errado</h1>
        <p className="text-sm text-muted">Não foi possível carregar esta tela. Tente de novo.</p>
        <button type="button" onClick={reset} className="text-sm font-medium underline">
          Tentar de novo
        </button>
      </div>
    </main>
  );
}
