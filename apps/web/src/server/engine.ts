import 'server-only';
import { WahaClient, wahaConfigFromEnv, type WaEngine } from '@mag/wa-engine';
import { FakeEngine } from '@mag/wa-engine/fake';

// globalThis: o FakeEngine guarda estado em memória e precisa ser o mesmo em todas as rotas do `next dev`
const g = globalThis as typeof globalThis & { __magEngine?: WaEngine };

/** WA_FAKE_ENGINE=1 → engine em memória (demo/e2e); senão o WAHA de WAHA_URL; sem nenhum dos dois → null. */
export function serverEngine(): WaEngine | null {
  if (g.__magEngine) return g.__magEngine;
  if (process.env.WA_FAKE_ENGINE === '1') g.__magEngine = new FakeEngine();
  else if (process.env.WAHA_URL) g.__magEngine = new WahaClient(wahaConfigFromEnv());
  return g.__magEngine ?? null;
}
