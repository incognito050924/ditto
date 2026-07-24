/**
 * DITTO_MEMORY — the single master switch for the memory subsystem (ADR-0013
 * D4 rollback invariant). Default ON (unset ⇒ on). When `off`/`0`, every
 * auto-inject and instrumentation path must short-circuit so ditto behaves
 * byte-for-byte as it did without memory — the fail-open contract. Explicit
 * `ditto memory …` reads stay available even when off (a manual pull is the
 * user's call); this switch only gates the automatic surfaces.
 */
export function isMemoryEnabled(): boolean {
  const v = process.env.DITTO_MEMORY?.trim().toLowerCase();
  return v !== 'off' && v !== '0';
}
