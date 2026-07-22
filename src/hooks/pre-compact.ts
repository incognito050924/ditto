import type { HookHandler, HookInput } from './runtime';

/**
 * PreCompact handler — intentional no-op (wi_260722g7h ac-split).
 *
 * Handoff issuance is severed from every automatic path: handoffs are strictly
 * user-initiated (`ditto handoff write`). The pre-compaction work-item handoff
 * write this hook used to perform is REMOVED — compaction no longer produces a
 * handoff artifact. The hook binding itself stays registered (observational,
 * exit 0, never blocks) so the event routing contract is unchanged.
 */
export const preCompactHandler: HookHandler = async (_input: HookInput) => {
  return { exitCode: 0 };
};
