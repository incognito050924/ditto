/**
 * Discovery gate — the deterministic gap-only, evidence-bound safety core for
 * far-field category DISCOVERY (wi_260707phi ac-5/ac-6). A completeness/discovery
 * critic may propose NEW far-field categories the code floor never seeded; this
 * module is the deterministic gate their proposals flow through, mirroring how
 * coverage-relevance.ts consumes structured relevance-judge output.
 *
 * Per ADR-0001 ditto never calls a provider directly: the "scan the codebase →
 * propose candidate categories" reasoning is host-delegated to an agent (a later
 * skill node wires agents/coverage-discovery.md). This module only CONSUMES the
 * agent's structured candidate proposals and enforces two rules deterministically,
 * so a candidate can never surface at agent discretion:
 *
 *   1. evidence-bound (ac-5): a candidate WITHOUT a verifiable code citation (a
 *      file:line pointer or a dependency reference) never surfaces — the same
 *      no-grounding-no-candidate safety core as coverage-relevance.ts. This is the
 *      OUTER gate: an ungrounded proposal is dropped before its gap is even
 *      considered.
 *   2. gap-only (ac-6): a candidate whose domain is ALREADY covered by the effective
 *      taxonomy (floor + tier-② overrides) or by a routed-out receiving gate is
 *      dropped as re-confirmation noise. Only a genuine gap is admitted.
 *
 * PROJECT-SCOPED, NOT WI-scoped: the gate reads only {candidates, effective
 * taxonomy} — never a per-work-item coverage.json. This is deliberately NOT the
 * WI-scoped `attributeCoverageEscape` (coverage-feedback.ts), which requires
 * `store.exists(work_item_id)` + a seeded coverage.json and blanket-rejects
 * anything "not seeded in this work item's coverage map". Reusing that path for
 * project-wide discovery would reject genuine gaps. Here we reuse only the
 * missing-lens IDEA (floor∪covered gap classification), applied over the project's
 * effective category set.
 */

import { codePointerMapsTo } from '~/schemas/work-item';
import {
  CATEGORY_NODE_PREFIX,
  FAR_FIELD_ROUTED_OUT,
  type FarFieldCategory,
} from './coverage-taxonomy';

/**
 * One host-produced candidate category proposal. Structurally mirrors a
 * {@link FarFieldCategory} (id + probing-question lens) plus the `evidence`
 * grounding the discovery agent must attach — the code citation that makes the
 * proposal verifiable. This module never invents any of these fields; it only
 * gates them.
 */
export interface DiscoveryCandidate {
  /** Proposed category id (bare or cov-cat-* — normalized before the gap check). */
  id: string;
  /** The probing-question lens the candidate would add to the taxonomy (ac-1 shape). */
  lens: string;
  /** Grounding for the proposal — a verifiable code citation (file:line or dependency ref). */
  evidence: string;
}

/** Why a candidate did not surface (auditable — a drop is never silent). */
export type DiscoveryRejectReason = 'no_evidence' | 'reconfirms_covered';

/**
 * The gate's per-candidate verdict. One is returned for EVERY candidate (admitted
 * or not) so a rejection is auditable, never a silent drop — the same transparency
 * as the relevance gate. `lens`/`evidence` are carried through only on an admit (so
 * the caller can add the category); `reason`/`detail` are set only on a reject.
 */
export interface DiscoveryVerdict {
  id: string;
  admitted: boolean;
  /** Set only when admitted — the new category's lens to add to the taxonomy. */
  lens?: string;
  /** Set only when admitted — the grounding citation carried through. */
  evidence?: string;
  /** Set only when rejected — the machine reason. */
  reason?: DiscoveryRejectReason;
  /** Set only when rejected — a human-readable why. */
  detail?: string;
}

/**
 * Scoped-package dependency-reference shape (npm-style `@scope/name`). Unmistakably
 * a dependency coordinate — it can never be confused with prose. A manifest-anchored
 * dependency reference (`package.json:express`, `go.mod:github.com/x/y`,
 * `Cargo.toml:serde`) already satisfies the reused {@link codePointerMapsTo}
 * file:token grammar, so this only covers the scoped-package bare form.
 */
export const DEPENDENCY_REF_RE = /^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Strip an optional `cov-cat-` prefix so a candidate id matches a bare taxonomy id. */
function bareId(id: string): string {
  return id.startsWith(CATEGORY_NODE_PREFIX) ? id.slice(CATEGORY_NODE_PREFIX.length) : id;
}

/**
 * Whether `evidence` carries at least one verifiable code citation (ac-5). Accepts a
 * file:line code pointer (the reused {@link codePointerMapsTo} grammar — which also
 * covers manifest-anchored dependency references like `package.json:express`) OR a
 * scoped-package dependency reference. Deterministic: the evidence is split on
 * whitespace and each token is shape-tested, so a citation embedded in prose still
 * grounds the proposal while pure prose (no citation token) does not. Empty →
 * false. NO new citation syntax is introduced.
 */
export function citesCode(evidence: string): boolean {
  return evidence
    .split(/\s+/)
    .some((tok) => tok.length > 0 && (codePointerMapsTo.test(tok) || DEPENDENCY_REF_RE.test(tok)));
}

/**
 * The deterministic discovery gate (ac-5/ac-6). Given host-produced candidate
 * proposals and the project's EFFECTIVE taxonomy (floor + tier-② overrides,
 * `resolveTaxonomy`), return one verdict per candidate:
 *
 *   - evidence-bound (ac-5, OUTER): no verifiable code citation → reject
 *     `no_evidence` (a candidate without grounding never surfaces);
 *   - gap-only (ac-6): the candidate id already names a covered category (an
 *     effective taxonomy id OR a routed-out id whose domain lives at a receiving
 *     gate) → reject `reconfirms_covered` (no floor re-confirmation noise);
 *   - otherwise → admit (a genuine, grounded gap).
 *
 * Structural, not semantic: the SEMANTIC "is this really a new domain?" judgment is
 * the host discovery agent's job; this gate enforces the structural floor that a
 * candidate must (a) be grounded and (b) not re-use an already-covered category id —
 * exactly the missing-lens idea of `attributeCoverageEscape`, but PROJECT-SCOPED
 * (no CoverageStore, no work_item_id, no per-WI coverage.json), so it never
 * blanket-rejects a genuine gap.
 */
export function admitDiscoveredCategories(
  candidates: readonly DiscoveryCandidate[],
  taxonomy: readonly FarFieldCategory[],
): DiscoveryVerdict[] {
  const covered = new Set<string>([
    ...taxonomy.map((c) => bareId(c.id)),
    ...FAR_FIELD_ROUTED_OUT.map((r) => bareId(r.id)),
  ]);
  return candidates.map((cand) => {
    // ac-5 safety core FIRST — no grounding, no candidate (outer gate).
    if (!citesCode(cand.evidence)) {
      return {
        id: cand.id,
        admitted: false,
        reason: 'no_evidence',
        detail:
          'candidate evidence carries no verifiable code citation (file:line or dependency reference) — a proposal without grounding never surfaces (ac-5)',
      };
    }
    // ac-6 gap-only — drop a candidate whose domain is already covered.
    const bare = bareId(cand.id);
    if (covered.has(bare)) {
      return {
        id: cand.id,
        admitted: false,
        reason: 'reconfirms_covered',
        detail: `category '${bare}' is already covered by the effective taxonomy (or routed out to a receiving gate) — re-confirming it adds no gap (ac-6)`,
      };
    }
    return { id: cand.id, admitted: true, lens: cand.lens, evidence: cand.evidence };
  });
}
