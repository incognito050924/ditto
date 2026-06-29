import { describe, expect, test } from 'bun:test';

// ac-6 (wi_2606299kn) — the REAL multi-repo e2e smoke is the runnable harness
// scripts/smoke-workspace-sync.ts (`bun scripts/smoke-workspace-sync.ts`), which is
// the ac-6 evidence. It is HEAVY: it spawns git + a nested `ditto workspace sync` +
// real clones + real pushes. ditto's OWN pre-push runs `bun test`, so running this by
// default would fire the heavy smoke on EVERY push. So it is gated behind SMOKE=1 —
// the default `bun test` SKIPS this block and stays fast.
const RUN = process.env.SMOKE === '1';

(RUN ? describe : describe.skip)('workspace-sync multi-repo e2e smoke (SMOKE=1)', () => {
  test('sync clones + installs WS_ROOT-pinned hook; root gate blocks/allows; ROOT-ONLY (no PWNED)', async () => {
    const { runSmoke } = await import('../../scripts/smoke-workspace-sync.ts');
    const r = await runSmoke();
    expect(r.cloned).toBe(true); // sub-repo cloned into <ws>/sub
    expect(r.wsRootPinned.length).toBeGreaterThan(0); // hook pins the workspace root
    expect(r.blockedExit).not.toBe(0); // protected push blocked under a failing root gate
    expect(r.allowedExit).toBe(0); // protected push allowed under a passing root gate
    expect(r.rootOnlyExit).toBe(0); // ROOT-ONLY push allowed (root gate's touch passes)
    expect(r.rootRan).toBe(true); // the workspace-root recipe's gate ran
    expect(r.pwnedCreated).toBe(false); // the clone's OWN recipe NEVER ran (ROOT-ONLY)
  }, 120_000);
});
