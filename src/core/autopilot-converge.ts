import type { AutopilotNode } from '~/schemas/autopilot';
import { kindToOwner } from './autopilot-graph';

/**
 * Forward re-expansion planner (autopilot §2.4 · §4.3).
 *
 * The node-*between* convergence loop ("수정+재리뷰까지 issues 0"). It is NOT a
 * back-edge to the review node — that would break the DAG/cycle-free invariant
 * (§2.1). Instead a `review`/`verify`/`security` node that still has findings
 * spawns a *new* `fix` node + *new* `review` node whose edges always point at an
 * already-existing node, so the merged graph stays acyclic and `addNodes`
 * (`validateNodeAddition`) accepts the splice.
 *
 * This is a pure planner — it owns no I/O and mutates nothing. The driver decides
 * to call it, splices the returned nodes through `AutopilotStore.addNodes`, and
 * tracks `round`. It is kept separate from `recordResult` on purpose: that path
 * owns the node-*internal* retry layer (`attempts`), and §2.4 forbids mixing the
 * two convergence layers.
 */
/**
 * Which forward fix→recheck trigger this re-expansion serves. ONE parameterized
 * planner, not three forks (CORE R3 / §4.3 — a shallow duplicate abstraction is
 * forbidden): all four shapes are the same fix→recheck splice.
 *  - `review`    — the existing node-*between* convergence loop (review/security
 *                  findings); lane-preserving (the recheck mirrors the seed kind).
 *  - `reverify`  — ac-2: re-verify an evidence-collectable unverified in-scope AC.
 *  - `risk_fix`  — ac-3: fix an in-scope agent_resolvable residual risk.
 *  - `follow_up` — ac-4: do an in-scope follow-up.
 *  - `defect_fix` — wi_2607148yg ac-1: fix a REPRODUCED real-behavior defect discovered
 *                   mid-run, materialized into its own back-linked work item and
 *                   chain-driven to done in the SAME run. It is a same-graph forward
 *                   splice ON PURPOSE (ac-6): the drive rounds carry the `.rev.r` marker
 *                   so `totalForwardRounds` counts them against the ORIGINATING run's
 *                   `loop_rounds` — the derived defect shares the run's budget instead of
 *                   spinning up a fresh per-WI caps block (which would let N nested defects
 *                   run N×loop_rounds, unbounded).
 * The new triggers converge through a `verify` recheck (the verifier collects fresh
 * evidence and judges the item resolved).
 */
export type ForwardTrigger = 'review' | 'reverify' | 'risk_fix' | 'follow_up' | 'defect_fix';

/**
 * The conservative discovered-defect classification (wi_2607148yg ac-2). A discovered
 * real-behavior defect is DRIVE-eligible (materialize + chain-drive in the same run) ONLY
 * when it is a re-run-REPRODUCED CURRENT-harm bug. Every other shape — a not-reproduced /
 * uncertain finding, a LATENT bug (no current harm), tech-debt, or an UNRELATED pre-existing
 * failure — routes to BACKLOG-only materialization (persisted so it is never silently
 * dropped, but NOT driven). This is the reproduction gate the drive route keys on — the
 * VERDICT, not a self-declared free-text label, so an in-scope idea relabeled "defect" that
 * is not reproduced never gets auto-driven (relabel resistance, ac-5).
 */
export type DefectDriveVerdict = 'drive' | 'backlog';

/** Inputs a node reports about one discovered defect; the classifier reads only these facts. */
export interface DiscoveredDefectSignal {
  /** Was CURRENT harm actually reproduced by a re-run (the drive precondition)? */
  reproduced: boolean;
  /** Latent bug — real but no current harm. Any of these exclusions ⇒ backlog, never drive. */
  latent?: boolean | undefined;
  /** Pre-existing tech-debt, not a regression this run caused. */
  tech_debt?: boolean | undefined;
  /** An unrelated pre-existing test/behavior failure not caused by this change. */
  unrelated_preexisting?: boolean | undefined;
}

/**
 * Reproduction-gated, CONSERVATIVE (ac-2): `drive` iff the defect is reproduced AND carries
 * no backlog-only exclusion (latent / tech-debt / unrelated pre-existing). Not reproduced or
 * uncertain ⇒ `backlog` (never drive on uncertainty). Pure and deterministic — condition-b
 * (a security/system/project/feature-design ADVERSE fix decision) is a SEPARATE fail-closed
 * gate ANDed at the drive site (gates.defectFixRequiresConditionB), not folded in here.
 */
export function classifyDiscoveredDefect(d: DiscoveredDefectSignal): DefectDriveVerdict {
  if (!d.reproduced) return 'backlog';
  if (d.latent || d.tech_debt || d.unrelated_preexisting) return 'backlog';
  return 'drive';
}

export interface ReviewOutcome {
  /** The review/verify/security node that just ran (the loop's current tail). */
  reviewNode: AutopilotNode;
  /**
   * Owner agent verdict: true ⇒ findings>0 (loop NOT closed); false ⇒ findings=0.
   * Only this verdict may close the loop — a quantitative budget never can (§4.3).
   */
  hasFindings: boolean;
  /** Forward rounds already spliced for this loop (0 for the first re-expansion). */
  round: number;
  /** Convergence budget (`caps.converge_rounds`): max forward rounds before escalate. */
  budget: number;
  /**
   * Which forward trigger this is. Optional + defaults to `review` so the existing
   * convergence-loop call site (autopilot-loop.ts) is byte-identical (additive).
   */
  trigger?: ForwardTrigger;
  /**
   * R5 / ADR-0018 graceful-degrade. Set ONLY when the sole reason the item cannot be
   * fixed-and-rechecked is an OPTIONAL tool's absence (CodeQL/playwright/LSP). The
   * planner then surfaces the residual `blocked_external` + grounding and refuses to
   * splice — an `agent_resolvable` re-verify would loop forever because grounding
   * releases blocked_external at the gate but NEVER agent_resolvable (gates.ts:222-237).
   */
  blockedByOptionalTool?: { tool: string; grounding: string };
}

/**
 * Two-layer escape (§4.3):
 *  - `close`    — findings=0 verdict closed the loop (→ pass). Agent verdict only.
 *  - `expand`   — findings>0 and budget remains → splice a fix + review round.
 *  - `escalate` — findings>0 and budget exhausted → STOP but do not close. This is
 *                 `user_decision_needed` (cap-reached ≠ converged); never a pass.
 */
export type ForwardReexpansion =
  | { decision: 'close' }
  | { decision: 'expand'; nodes: AutopilotNode[] }
  | { decision: 'escalate'; reason: string }
  // R5 / ADR-0018: optional-tool absence — surface the residual as `blocked_external`
  // (NEVER `agent_resolvable`) with grounding, and do NOT splice (an unfixable
  // re-verify would loop). The driver routes this onto the completion contract.
  | { decision: 'surface'; resolvability: 'blocked_external'; grounding: string; reason: string };

// Single source of truth for the forward-node id scheme. The REVIEW marker also
// encodes the loop's forward depth, so `forwardRound` derives `round` from a
// node id without any extra stored state (the driver must not be trusted to keep
// a counter — the deterministic floor reconstructs it from the graph).
const FORWARD_FIX_MARKER = '.fix.r';
const FORWARD_REVIEW_MARKER = '.rev.r';

/**
 * Forward-chain depth of a review node, read off its id (mirrors the id scheme in
 * `planForwardReexpansion`): a root review has round 0; each forward re-expansion
 * appends one REVIEW marker (`R → R.rev.r0 → R.rev.r0.rev.r1 → …`), so the marker
 * count is the round to splice next.
 */
export function forwardRound(reviewNodeId: string): number {
  return reviewNodeId.split(FORWARD_REVIEW_MARKER).length - 1;
}

/**
 * Graph-derived loop-level forward-round total (ADR-0024 Decision 6). The per-chain
 * `forwardRound` counts depth within ONE review chain; this sums the forward rounds
 * spliced across the WHOLE graph — one per existing forward review node (each such
 * node is one re-expansion that already happened). It is read off node ids, NOT a
 * driver-trusted stored counter (the deterministic floor reconstructs it from the
 * graph), so the loop-level iteration cap cannot be defeated by a lost counter.
 */
export function totalForwardRounds(nodeIds: readonly string[]): number {
  return nodeIds.filter((id) => id.includes(FORWARD_REVIEW_MARKER)).length;
}

function mkNode(
  id: string,
  kind: AutopilotNode['kind'],
  purpose: string,
  depends_on: string[],
  acceptance_refs: string[],
): AutopilotNode {
  return {
    id,
    kind,
    owner: kindToOwner(kind),
    purpose,
    status: 'pending',
    depends_on,
    acceptance_refs,
    evidence_refs: [],
    ac_verdicts: [],
    attempts: { fix: 0, switch: 0 },
  };
}

/**
 * Per-trigger fix→recheck shape (the only thing that varies across the four
 * triggers): the recheck node's kind and the two purpose strings. The `review`
 * branch is lane-preserving (recheck mirrors the seed kind) and byte-identical to
 * the original planner; the three new triggers recheck via `verify`.
 */
function forwardShape(
  trigger: ForwardTrigger,
  seed: AutopilotNode,
  round: number,
  fixId: string,
): { recheckKind: AutopilotNode['kind']; fixPurpose: string; reviewPurpose: string } {
  switch (trigger) {
    case 'reverify':
      return {
        recheckKind: 'verify',
        fixPurpose: `Collect evidence for the unverified in-scope criteria raised by ${seed.id} (round ${round})`,
        reviewPurpose: `Re-verify after ${fixId}; close only on an evidence-backed pass verdict`,
      };
    case 'risk_fix':
      return {
        recheckKind: 'verify',
        fixPurpose: `Resolve the agent_resolvable residual risk surfaced by ${seed.id} (round ${round})`,
        reviewPurpose: `Re-verify after ${fixId}; close only when the risk is verified resolved`,
      };
    case 'follow_up':
      return {
        recheckKind: 'verify',
        fixPurpose: `Address the in-scope follow-up surfaced by ${seed.id} (round ${round})`,
        reviewPurpose: `Re-verify after ${fixId}; close only when the follow-up is verified done`,
      };
    case 'defect_fix':
      return {
        recheckKind: 'verify',
        fixPurpose: `Fix the reproduced real-behavior defect discovered by ${seed.id} as its OWN work item/commit (never merged into the origin diff), chain-driven in the same run (round ${round})`,
        reviewPurpose: `Re-verify after ${fixId}; close only when the discovered defect is verified fixed`,
      };
    default: // 'review' — existing convergence loop, lane-preserving (unchanged)
      return {
        recheckKind: seed.kind,
        fixPurpose: `Resolve findings raised by ${seed.id} (round ${round})`,
        reviewPurpose: `Re-check after ${fixId}; close the loop only on a findings=0 verdict`,
      };
  }
}

export function planForwardReexpansion(outcome: ReviewOutcome): ForwardReexpansion {
  const { reviewNode, hasFindings, round, budget } = outcome;
  const trigger = outcome.trigger ?? 'review';

  // (1) Convergence escape: the owner's findings=0 verdict closes the loop. This
  // takes priority over the budget — only the agent verdict may close (§4.3).
  if (!hasFindings) return { decision: 'close' };

  // (R5 / ADR-0018) Optional-tool absence: do NOT emit an endless re-verify splice.
  // Surface the residual `blocked_external` + grounding (which the gate honours),
  // never `agent_resolvable` (which the gate blocks unconditionally — grounding
  // does not release it, gates.ts:222-237 — so the re-verify would loop forever).
  // Checked before the expand path so a tool-absent item never consumes a round.
  if (outcome.blockedByOptionalTool) {
    const { tool, grounding } = outcome.blockedByOptionalTool;
    return {
      decision: 'surface',
      resolvability: 'blocked_external',
      grounding,
      reason: `${trigger} cannot be auto-fixed: optional tool '${tool}' is absent (ADR-0018 graceful-degrade). Surfaced blocked_external with grounding, not agent_resolvable — an agent_resolvable re-verify would loop because grounding never releases it (gates.ts:222-237).`,
    };
  }

  // (2) Budget escape: findings remain but the forward-round budget is spent. Stop
  // without closing — escalate as user_decision_needed, never pass (§4.3).
  if (round >= budget) {
    return {
      decision: 'escalate',
      reason: `forward re-expansion budget reached (round ${round} ≥ converge_rounds ${budget}) with findings still open on ${reviewNode.id}; cap-reached ≠ converged, escalate rather than pass`,
    };
  }

  // (3) Expand: one fix round then a fresh re-check, edges pointing only backward
  // in time (fix→reviewNode, review→fix), so the merged graph stays acyclic. The
  // recheck node id always reuses FORWARD_REVIEW_MARKER (R2 cap inheritance) so
  // every trigger's splice is counted by totalForwardRounds — the graph-wide
  // no-progress floor. The recheck KIND is parameterized by trigger: the `review`
  // loop preserves its lifecycle lane (a `security` finding is re-checked by
  // `security`), while ac-2/ac-3/ac-4 converge through a `verify` recheck.
  const fixId = `${reviewNode.id}${FORWARD_FIX_MARKER}${round}`;
  const reviewId = `${reviewNode.id}${FORWARD_REVIEW_MARKER}${round}`;
  const shape = forwardShape(trigger, reviewNode, round, fixId);
  const fix = mkNode(fixId, 'fix', shape.fixPurpose, [reviewNode.id], reviewNode.acceptance_refs);
  const review = mkNode(
    reviewId,
    shape.recheckKind,
    shape.reviewPurpose,
    [fixId],
    reviewNode.acceptance_refs,
  );
  return { decision: 'expand', nodes: [fix, review] };
}
