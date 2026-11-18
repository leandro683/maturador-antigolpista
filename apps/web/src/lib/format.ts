/** Formatos brasileiros únicos do painel (datas em America/Sao_Paulo, milhar com ponto). */

export const nf = new Intl.NumberFormat('pt-BR');
export const pf = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

const TZ = 'America/Sao_Paulo';
const dtShort = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: TZ });
const dtMedium = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium', timeZone: TZ });
const dOnly = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: TZ });

const toDate = (d: Date | string | number) => (d instanceof Date ? d : new Date(d));

/** 18/10/2026 14:05 (ou "—") */
export function fmtDateTime(d: Date | string | number | null | undefined): string {
  return d == null || d === '' ? '—' : dtShort.format(toDate(d));
}

/** 18/10/2026 14:05:09 (ou "—") */
export function fmtDateTimeSec(d: Date | string | number | null | undefined): string {
  return d == null || d === '' ? '—' : dtMedium.format(toDate(d));
}

/** 18/10/2026 (ou "—") */
export function fmtDay(d: Date | string | number | null | undefined): string {
  return d == null || d === '' ? '—' : dOnly.format(toDate(d));
}

/** 1.186 (ou "—" p/ nulo) */
export function fmtNum(n: number | null | undefined): string {
  return n == null || Number.isNaN(n) ? '—' : nf.format(n);
}
