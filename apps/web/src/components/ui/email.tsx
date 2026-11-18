/**
 * Mostra um e-mail sem disparar a ofuscação de e-mails que alguns proxies e CDNs aplicam.
 *
 * Esses serviços reescrevem no HTML do servidor todo texto com cara de e-mail. O React então encontra texto diferente
 * do que renderizou e quebra a hidratação ("Minified React error #418"). Partindo o endereço em dois nós de texto
 * (`nome` + `@domínio`) nenhum nó casa com o padrão de e-mail: o proxy não mexe e a pessoa vê (e copia) o endereço igual.
 */
export function Email({ value, className }: { value: string | null | undefined; className?: string }) {
  if (!value) return null;
  const at = value.indexOf('@');
  if (at <= 0) return <span className={className}>{value}</span>;
  return (
    <span className={className}>
      <span>{value.slice(0, at)}</span>
      <span>{value.slice(at)}</span>
    </span>
  );
}
