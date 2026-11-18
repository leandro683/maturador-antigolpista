import type { ReactNode } from 'react';

/** Liga/desliga com 1 clique: formulário com campos ocultos e um botão `switch` (sem JS no cliente). */
export function Toggle({
  action,
  fields,
  on,
  label,
  disabled,
}: {
  action: (fd: FormData) => void | Promise<void>;
  fields: Record<string, string>;
  on: boolean;
  label: string;
  disabled?: boolean;
}): ReactNode {
  return (
    <form action={action} className="inline-block">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button
        type="submit"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        className="relative inline-block h-[22px] w-[38px] shrink-0 rounded-full bg-border-strong transition-colors aria-checked:bg-accent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent after:absolute after:left-[3px] after:top-[3px] after:size-4 after:rounded-full after:bg-white after:transition-transform aria-checked:after:translate-x-4 motion-reduce:transition-none motion-reduce:after:transition-none"
      />
    </form>
  );
}
