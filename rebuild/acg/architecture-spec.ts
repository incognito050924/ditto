import { z } from 'zod';

/**
 * ACG ArchitectureSpec — the per-repo, machine-checkable declaration of the
 * intended structure (layers, public surfaces, forbidden dependencies). Consumed
 * by the fitness/conformance gate; a catalog artifact built once and reused.
 *
 * This is the rebuild re-expression of the ADR-0004 Q3 contract, NOT a copy of
 * src/. The load-bearing decisions preserved here:
 *  - the spec SOURCE is DEFERRED / pluggable (ArchitectureSpecSource) — the core
 *    never hardcodes where the spec comes from (user file, agent candidate,
 *    fixture); it is injected;
 *  - user authority is the default — only produced_by=user is authoritative;
 *  - the agent candidate path is NON-authoritative and NEVER auto-fossilizes
 *    forbidden_dependencies (auto-forbidding the current code would freeze
 *    accidental structure into a rule). Rules are the human's, via ratification.
 */

export const architectureProducedBy = z.enum(['agent', 'user']);
export type ArchitectureProducedBy = z.infer<typeof architectureProducedBy>;

export const architectureSpec = z
  .object({
    produced_by: architectureProducedBy,
    produced_at: z.string().min(1),
    // layer name → allowed call targets (rules; empty on an observed candidate).
    layers: z.record(z.string(), z.object({ can_call: z.array(z.string()).default([]) })).default(
      {},
    ),
    public_surfaces: z.array(z.string().min(1)).default([]),
    forbidden_dependencies: z
      .array(z.object({ from: z.string().min(1), to: z.string().min(1), reason: z.string().min(1) }))
      .default([]),
  })
  .strict();
export type ArchitectureSpec = z.infer<typeof architectureSpec>;

export type ForbiddenDependency = ArchitectureSpec['forbidden_dependencies'][number];

/**
 * The DEFERRED / pluggable spec source (ADR-0004 Q3). The conformance core
 * depends only on this interface — never on a real `.ditto` file, a git repo, or
 * an agent extractor — so the whole contract is unit-testable with an injected
 * source. `load` returns undefined when no spec has been provisioned; it never
 * fabricates one.
 */
export interface ArchitectureSpecSource {
  load(): Promise<ArchitectureSpec | undefined>;
}

/** Only a user-produced spec is authoritative; an agent candidate is not. */
export function isAuthoritative(spec: ArchitectureSpec): boolean {
  return spec.produced_by === 'user';
}

/**
 * Load the authoritative spec from an injected source. A source that yields
 * nothing — or only a non-authoritative candidate — returns undefined: the gate
 * must never treat a candidate as the ratified spec (fail-closed on authority).
 */
export async function loadAuthoritativeSpec(
  source: ArchitectureSpecSource,
): Promise<ArchitectureSpec | undefined> {
  const spec = await source.load();
  if (spec === undefined) return undefined;
  return isAuthoritative(spec) ? spec : undefined;
}

/** What an observer supplies to build a candidate — names only, no rules. */
export interface ArchitectureObservation {
  layers: string[];
  publicSurfaces: string[];
}

/**
 * Assemble a NON-authoritative candidate spec (produced_by=agent). The
 * invariants hold regardless of input: forbidden_dependencies is ALWAYS empty
 * (never auto-fossilized) and layers carry names only (can_call empty) — this is
 * observed structure a human must ratify, not a rule.
 */
export function buildCandidateSpec(
  obs: ArchitectureObservation,
  producedAt: string,
): ArchitectureSpec {
  return architectureSpec.parse({
    produced_by: 'agent',
    produced_at: producedAt,
    layers: Object.fromEntries([...new Set(obs.layers)].sort().map((l) => [l, { can_call: [] }])),
    public_surfaces: [...new Set(obs.publicSurfaces)].sort(),
    forbidden_dependencies: [],
  });
}

export interface RatifyOptions {
  /** Forbidden deps the human explicitly declared — NEVER auto-derived. */
  forbidden: ForbiddenDependency[];
  ratifiedAt: string;
}

/**
 * Promote a candidate to authoritative (produced_by=user). Pure. forbidden_
 * dependencies come ONLY from the human's explicit arg (empty stays empty).
 * Refuses a spec that is already authoritative — re-ratifying would silently
 * clobber a human-owned spec.
 */
export function ratifyCandidateSpec(
  candidate: ArchitectureSpec,
  opts: RatifyOptions,
): ArchitectureSpec {
  if (candidate.produced_by === 'user') {
    throw new Error(
      'ratify: spec is already authoritative (produced_by=user) — nothing to ratify',
    );
  }
  return architectureSpec.parse({
    ...candidate,
    produced_by: 'user',
    produced_at: opts.ratifiedAt,
    forbidden_dependencies: opts.forbidden,
  });
}
