import type { AcgArchitectureSpec } from '~/schemas/acg-architecture-spec';
import { acgArchitectureSpec } from '~/schemas/acg-architecture-spec';

/**
 * ArchitectureSpec ratification (ADR-0004) — the last cell of observe→ratify→enforce.
 *
 * `propose` emits a NON-AUTHORITATIVE candidate (produced_by=agent). Ratification
 * is the explicit human act that promotes that candidate to the authoritative spec
 * (produced_by=user), which PreToolUse + the boundary gate already enforce.
 *
 * INVARIANTS (ADR-0004, must not violate):
 *   - forbidden_dependencies are NEVER fossilized from observation — they are filled
 *     ONLY from the human's explicit `forbidden` arg (empty stays empty);
 *   - layers/public_surfaces are carried through verbatim (the human ratifies the
 *     observed structure), and can_call is NOT auto-derived (kept as the candidate left it);
 *   - promotion to produced_by=user happens only via this explicit call.
 */

export type ForbiddenDependency = AcgArchitectureSpec['forbidden_dependencies'][number];

export interface RatifyOptions {
  /** Forbidden deps the human explicitly declared (NEVER auto-derived from observation). */
  forbidden: ForbiddenDependency[];
  ratifiedAt: string;
}

/**
 * Promote a candidate ArchitectureSpec to authoritative. Pure. Refuses a spec that
 * is already authoritative — re-ratifying would silently clobber a human-owned spec.
 */
export function ratifyCandidateSpec(
  candidate: AcgArchitectureSpec,
  opts: RatifyOptions,
): AcgArchitectureSpec {
  if (candidate.produced_by === 'user') {
    throw new Error('ratify: spec is already authoritative (produced_by=user) — nothing to ratify');
  }
  return acgArchitectureSpec.parse({
    ...candidate,
    produced_by: 'user',
    produced_at: opts.ratifiedAt,
    // INVARIANT: rules come from the human, never from observation.
    forbidden_dependencies: opts.forbidden,
  });
}
