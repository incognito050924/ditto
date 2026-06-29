import { describe, expect, test } from 'bun:test';

// ac-6 (wi_260629i9c) — the REAL foreign-repo push-gate smoke is the runnable
// harness scripts/smoke-push-gate.ts (`bun scripts/smoke-push-gate.ts`), which is
// the ac-6 evidence. It is HEAVY: it spawns git + a nested `ditto setup` + real
// pushes. ditto's OWN pre-push now runs `bun test`, so running this by default
// would fire the heavy smoke on EVERY push. So it is gated behind SMOKE=1 — the
// default `bun test` SKIPS this block and stays fast.
const RUN = process.env.SMOKE === '1';

(RUN ? describe : describe.skip)('push-gate foreign-repo smoke (SMOKE=1)', () => {
  test('FAILING gate BLOCKS the protected push; PASSING gate ALLOWS it', async () => {
    const { runSmoke } = await import('../../scripts/smoke-push-gate.ts');
    const r = await runSmoke();
    expect(r.blockedExit).not.toBe(0); // protected push blocked under a failing gate
    expect(r.allowedExit).toBe(0); // protected push allowed under a passing gate
    expect(r.nonProtectedExit).toBe(0); // non-protected push allowed regardless
  }, 120_000);
});
