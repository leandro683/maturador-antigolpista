/**
 * Subida do chip: dia no maturador (1 = primeiro) → falas enviadas por dia e parceiros distintos por dia.
 * Falas: 60 / 80 / 100. Parceiros seguem a subida lenta.
 */
export function rampFor(day: number): { goal: number; partners: number } {
  const goal = day <= 1 ? 60 : day === 2 ? 80 : 100;
  const partners = day <= 2 ? 2 : day <= 5 ? 3 : day <= 10 ? 5 : Infinity;
  return { goal, partners };
}
