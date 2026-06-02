import type { Autopilot } from '~/schemas/autopilot';
import type { CompletionContract } from '~/schemas/completion-contract';
import type { WorkItem } from '~/schemas/work-item';
import { type CompletionInput, buildCompletion } from './completion-store';

/**
 * Assemble a completion contract from a finished autopilot graph (done→completion
 * bridge). This automates the mechanical assembly — mapping each acceptance
 * criterion to the evidence the nodes collected and deriving its verdict — that
 * was otherwise hand-written each run.
 *
 * It is NOT auto-pass. The verdict is *evidence-gated*: a criterion passes only
 * when an addressing node passed AND carried evidence; a passed node with no
 * evidence yields `unverified` (claim ≠ proof — the prime directive). So
 * `final_verdict=pass` still requires every criterion closed with real evidence,
 * exactly as §6.8 / the completion gate demand — this only stops re-typing it.
 */
type DerivedVerdict = CompletionInput['verdicts'][number];

export function deriveAcVerdicts(graph: Autopilot, acIds: string[]): DerivedVerdict[] {
  return acIds.map((acId) => {
    const addressing = graph.nodes.filter((n) => n.acceptance_refs.includes(acId));
    const evidence = addressing.flatMap((n) => n.evidence_refs);
    const anyFailed = addressing.some((n) => n.status === 'failed');
    const anyPassed = addressing.some((n) => n.status === 'passed');

    if (anyFailed) {
      return { criterion_id: acId, verdict: 'fail', evidence, notes: 'an addressing node failed' };
    }
    if (anyPassed && evidence.length > 0) {
      return { criterion_id: acId, verdict: 'pass', evidence };
    }
    if (anyPassed) {
      return {
        criterion_id: acId,
        verdict: 'unverified',
        evidence,
        notes: 'addressing node passed without evidence (claim ≠ proof)',
      };
    }
    return {
      criterion_id: acId,
      verdict: 'unverified',
      evidence,
      notes:
        addressing.length === 0
          ? 'no node addressed this criterion'
          : 'addressing node not terminal',
    };
  });
}

export interface AssembleOptions {
  /** Operator/verifier narrative; a terse default is derived when omitted. */
  summary?: string;
  remainingRisks?: string[];
  now?: Date;
}

export function assembleCompletionFromGraph(
  graph: Autopilot,
  workItem: WorkItem,
  opts: AssembleOptions = {},
): CompletionContract {
  const acIds = workItem.acceptance_criteria.map((c) => c.id);
  const verdicts = deriveAcVerdicts(graph, acIds);
  const summary =
    opts.summary ??
    `Completion assembled from autopilot ${graph.autopilot_id} (${graph.nodes.length} nodes) for "${workItem.goal}".`;
  return buildCompletion({
    workItem,
    declaredBy: 'verifier',
    summary,
    verdicts,
    ...(opts.remainingRisks ? { remainingRisks: opts.remainingRisks } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
}
