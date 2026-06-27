/**
 * Single master switch for the whole memory subsystem (rollback invariant, §10-9 ①).
 *
 * `DITTO_MEMORY` unset ⇒ on (default). `DITTO_MEMORY=off` (or `0`) ⇒ off — this is
 * the ONE flag that disables the subsystem's automatic/instrumented paths. It
 * subsumes the granular `DITTO_MEMORY_WARMSTART` switch: when the master is off,
 * warm-start is off regardless of `DITTO_MEMORY_WARMSTART` (no flag proliferation).
 *
 * "Disabled" means the auto-inject + instrumentation paths short-circuit (§5 push
 * goes fail-open ⇒ ditto behaves byte-for-byte as it did without memory). Explicit
 * `ditto memory …` CLI calls are a user's own pull and are intentionally left to
 * still run — disabling here targets auto-injection, not manual consultation.
 */
export function isMemoryEnabled(): boolean {
  const v = process.env.DITTO_MEMORY?.trim().toLowerCase();
  return v !== 'off' && v !== '0';
}
