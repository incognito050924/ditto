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
  | { decision: 'escalate'; reason: string };

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
    attempts: { fix: 0, switch: 0 },
  };
}

export function planForwardReexpansion(outcome: ReviewOutcome): ForwardReexpansion {
  const { reviewNode, hasFindings, round, budget } = outcome;

  // (1) Convergence escape: the owner's findings=0 verdict closes the loop. This
  // takes priority over the budget — only the agent verdict may close (§4.3).
  if (!hasFindings) return { decision: 'close' };

  // (2) Budget escape: findings remain but the forward-round budget is spent. Stop
  // without closing — escalate as user_decision_needed, never pass (§4.3).
  if (round >= budget) {
    return {
      decision: 'escalate',
      reason: `forward re-expansion budget reached (round ${round} ≥ converge_rounds ${budget}) with findings still open on ${reviewNode.id}; cap-reached ≠ converged, escalate rather than pass`,
    };
  }

  // (3) Expand: one fix round then a fresh review, edges pointing only backward in
  // time (fix→reviewNode, review→fix), so the merged graph stays acyclic.
  const fixId = `${reviewNode.id}.fix.r${round}`;
  const reviewId = `${reviewNode.id}.rev.r${round}`;
  const fix = mkNode(
    fixId,
    'fix',
    `Resolve findings raised by ${reviewNode.id} (round ${round})`,
    [reviewNode.id],
    reviewNode.acceptance_refs,
  );
  const review = mkNode(
    reviewId,
    'review',
    `Re-review after ${fixId}; close the loop only on a findings=0 verdict`,
    [fixId],
    reviewNode.acceptance_refs,
  );
  return { decision: 'expand', nodes: [fix, review] };
}
