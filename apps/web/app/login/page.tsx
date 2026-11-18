import { Alert } from '@/components/ui/form';
import { authConfigError } from '@/lib/auth';
import { LoginForm } from './login-form';

export const metadata = { title: 'Entrar · Maturador + Anti-golpista' };
export const dynamic = 'force-dynamic'; // lê as variáveis de ambiente em tempo de execução

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const config = authConfigError();
  return (
    <main className="grid min-h-screen place-items-center bg-navy px-4 py-6">
      <div className="grid w-full max-w-[400px] gap-4 rounded-xl bg-card p-8">
        <p className="text-sm font-semibold text-muted">Maturador + Anti-golpista</p>
        <h1 className="font-heading text-[38px] font-bold leading-none">Entrar</h1>
        {config && <Alert tone="bad">Configuração incompleta: {config}</Alert>}
        <LoginForm next={next} />
      </div>
    </main>
  );
}
