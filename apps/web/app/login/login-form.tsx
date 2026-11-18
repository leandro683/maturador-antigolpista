'use client';

import { useActionState, useEffect, useState } from 'react';
import { buttonClass } from '@/components/ui/button';
import { Alert, Field, inputClass } from '@/components/ui/form';
import { cn } from '@/lib/cn';
import { entrar, type LoginState } from './actions';

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(entrar, {});
  // controlado: o React 19 limpa os campos não controlados depois de cada envio, e o e-mail digitado deve ficar
  const [email, setEmail] = useState('');
  useEffect(() => {
    if (state.destino) window.location.assign(state.destino);
  }, [state.destino]);
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="next" value={next ?? ''} />
      <Field label="E-mail">
        <input
          type="email"
          name="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="username"
          className={cn(inputClass, 'px-3 py-2.5 text-[15px]')}
        />
      </Field>
      <Field label="Senha">
        <input
          type="password"
          name="senha"
          required
          autoComplete="current-password"
          className={cn(inputClass, 'px-3 py-2.5 text-[15px]')}
        />
      </Field>
      <button type="submit" disabled={pending} className={buttonClass('primary', 'md', 'h-auto w-full py-3.5')}>
        Entrar
      </button>
      {state.erro && <Alert tone="bad">{state.erro}</Alert>}
    </form>
  );
}
