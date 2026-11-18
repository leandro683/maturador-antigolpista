/**
 * Início do dia `YYYY-MM-DD` no fuso `APP_TZ` (padrão America/Sao_Paulo); `end` = início do dia seguinte.
 * Data que não existe (31 de fevereiro) ou fuso inválido → `undefined`.
 */
export function zonedDay(s: string, end = false, tz = process.env.APP_TZ || 'America/Sao_Paulo'): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const wall = Date.UTC(y, mo - 1, d + (end ? 1 : 0)); // o "relógio de parede" desejado, lido como UTC
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return undefined;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    const offsetAt = (t: number) => {
      const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
      return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(t / 1000) * 1000;
    };
    const guess = wall - offsetAt(wall);
    return new Date(wall - offsetAt(guess)); // 2ª passada: acerta o deslocamento do próprio instante (horário de verão)
  } catch {
    return undefined;
  }
}
