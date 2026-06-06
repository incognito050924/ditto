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
type Verdict = DerivedVerdict['verdict'];

// Severity floor (worst → best). The fold takes the MIN rank, so it can only ever
// *lower* a verdict, never raise it: an explicit `pass` cannot upgrade an
// evidence-less `unverified`, and a per-AC `partial`/`fail` always wins over a
// node-level `pass`. This is the false-green fix — a per-AC non-pass cannot be
// absorbed by a node that passed as a node (§6.8, claim ≠ proof).
const SEVERITY: Record<Verdict, number> = { fail: 0, partial: 1, unverified: 2, pass: 3 };
const worst = (a: Verdict, b: Verdict): Verdict => (SEVERITY[a] <= SEVERITY[b] ? a : b);

export function deriveAcVerdicts(graph: Autopilot, acIds: string[]): DerivedVerdict[] {
  return acIds.map((acId) => {
    const addressing = graph.nodes.filter((n) => n.acceptance_refs.includes(acId));
    const evidence = addressing.flatMap((n) => n.evidence_refs);
    const anyFailed = addressing.some((n) => n.status === 'failed');
    const anyPassed = addressing.some((n) => n.status === 'passed');

    // 1) Structural verdict from node status + evidence presence (unchanged).
    let verdict: Verdict;
    let notes: string | undefined;
    if (anyFailed) {
      verdict = 'fail';
      notes = 'an addressing node failed';
    } else if (anyPassed && evidence.length > 0) {
      verdict = 'pass';
    } else if (anyPassed) {
      verdict = 'unverified';
      notes = 'addressing node passed without evidence (claim ≠ proof)';
    } else {
      verdict = 'unverified';
      notes =
        addressing.length === 0
          ? 'no node addressed this criterion'
          : 'addressing node not terminal';
    }

    // 2) Fold in any per-AC verdicts a judging node emitted for THIS criterion.
    // worst() only lowers, so a verifier's `partial` for an AC the node otherwise
    // passed survives to the completion gate instead of being over-closed to pass.
    const explicit = addressing.flatMap((n) =>
      n.ac_verdicts.filter((v) => v.criterion_id === acId),
    );
    for (const e of explicit) {
      const folded = worst(verdict, e.verdict);
      if (SEVERITY[folded] < SEVERITY[verdict]) {
        verdict = folded;
        notes =
          e.notes ??
          `verifier judged ${acId} ${e.verdict} (per-AC verdict caps the node-level pass)`;
      }
    }

    return { criterion_id: acId, verdict, evidence, ...(notes ? { notes } : {}) };
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
  // Non-terminal nodes ({pending, running, blocked}) mean graph work is unfinished;
  // surface them as a remaining risk after preserving any caller-supplied risks.
  const nonTerminal = graph.nodes.filter((n) => n.status !== 'passed' && n.status !== 'failed');
  const remainingRisks = [
    ...(opts.remainingRisks ?? []),
    ...(nonTerminal.length > 0
      ? [`non-terminal graph nodes (work unfinished): ${nonTerminal.map((n) => n.id).join(', ')}`]
      : []),
  ];
  return buildCompletion({
    workItem,
    declaredBy: 'verifier',
    summary,
    verdicts,
    ...(remainingRisks.length > 0 ? { remainingRisks } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
}
