/**
 * Loop guard do anti-hacker: no máx. `max` reações por chave (grupo + tipo) numa janela deslizante. Evita o app entrar
 * em loop consigo mesmo (ex.: revert de nome → evento de update → revert…) ou com outro bot que desfaz nossa ação.
 * Em memória por worker (1 processo) — suficiente: o pior caso entre réplicas é `max × réplicas`.
 */
export class ReactionLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private max = 5,
    private windowMs = 60_000,
    private now: () => number = Date.now,
  ) {}

  /** true = pode agir (e registra); false = limite atingido. */
  take(key: string): boolean {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 5_000) this.gc(t);
    return true;
  }

  private gc(t: number) {
    for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
  }
}
