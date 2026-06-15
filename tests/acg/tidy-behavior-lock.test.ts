import { describe, expect, test } from 'bun:test';
import {
  type CoverageProvider,
  type CoverageResult,
  assessBehaviorLock,
} from '~/acg/tidy/behavior-lock';

const region = { files: ['src/a.ts'], functions: ['doThing'] };
const provider = (result: CoverageResult): CoverageProvider => ({
  coverageOf: async () => result,
});

describe('assessBehaviorLock — L1 behavior lock (WU-1 ①)', () => {
  test('returns status blocked when the baseline suite is red (ac-3)', async () => {
    const v = await assessBehaviorLock({ baselineGreen: false, changedRegion: region });
    expect(v.status).toBe('blocked-baseline-red');
    expect(v.autoCommit).toBe('none');
  });

  test('fails open to degraded + diff-only when no coverage provider is wired (ac-5)', async () => {
    const v = await assessBehaviorLock({ baselineGreen: true, changedRegion: region });
    expect(v.status).toBe('degraded');
    expect(v.autoCommit).toBe('diff-only');
    // fail-open is neither a hard block nor a silent bypass
    expect(v.status).not.toBe('blocked-baseline-red');
  });

  test('returns status met + full auto-commit when a provider reports the region covered', async () => {
    const v = await assessBehaviorLock({
      baselineGreen: true,
      changedRegion: region,
      coverageProvider: provider({ status: 'covered', coveredRatio: 1 }),
    });
    expect(v.status).toBe('met');
    expect(v.autoCommit).toBe('full');
  });

  test('returns status unmet + no auto-commit when a present provider reports below threshold (ac-3)', async () => {
    const v = await assessBehaviorLock({
      baselineGreen: true,
      changedRegion: region,
      coverageProvider: provider({ status: 'uncovered', coveredRatio: 0.2 }),
    });
    expect(v.status).toBe('unmet');
    expect(v.autoCommit).toBe('none');
  });
});
