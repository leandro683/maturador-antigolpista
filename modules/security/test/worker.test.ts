import { describe, expect, it } from 'vitest';
import type { WaEngine } from '@mag/wa-engine';
import { SECURITY_SCAN_TYPE, securityScanType } from '../src/scan';
import { GID, setup } from './fixtures';

describe('tipo security-scan com deps (worker)', () => {
  it('roda 1 grupo com o repo e devolve o resultado do passo', async () => {
    const { repo } = setup();
    repo.agency = [];
    const def = securityScanType({ repo });
    expect(def.type).toBe(SECURITY_SCAN_TYPE);
    const fake = {
      getGroup: async () => ({ gid: GID, subject: 'x', announce: false, participants: [] }),
    } as unknown as WaEngine;
    const out = await def.runStep(fake, {
      session: 'chip-01',
      gid: GID,
      groupId: 'g1',
      payload: { messageLimit: 50, checkProfiles: false, autoAct: false },
      index: 0,
    });
    expect(out).toMatchObject({ result: { participants: 0, findings: 0 } });
  });
});
