import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';
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

/**
 * Evidence a node attached to ONE criterion via the matching `ac_verdict` entry's
 * own `evidence_refs`. A judging node can write proof where it judged (per-AC)
 * instead of mirroring it at the top level (wi_260622kb4). The AC-closing guard
 * (autopilot-dispatch.guardAcClosingEvidence) already accepts this path, so the
 * completion bridge must too — otherwise a node carrying only per-AC evidence
 * reads as "0 evidence → unverified".
 */
function perAcEvidence(node: AutopilotNode, acId: string) {
  return node.ac_verdicts
    .filter((v) => v.criterion_id === acId)
    .flatMap((v) => v.evidence_refs ?? []);
}

/**
 * Does `node` carry evidence that closes `acId` — top-level OR per-AC? Both paths
 * count (the guard accepts either); only when BOTH are empty is a passed node's
 * claim unbacked (claim ≠ proof).
 */
function hasClosingEvidence(node: AutopilotNode, acId: string): boolean {
  return node.evidence_refs.length > 0 || perAcEvidence(node, acId).length > 0;
}

/**
 * The verdict a single addressing node contributes for ONE criterion: its
 * evidence-gated structural verdict (status + evidence) lowered by any per-AC
 * verdict that node emitted for this criterion. This is the old flat fold,
 * evaluated per node so supersession can reason about *which* node failed vs.
 * which later node re-passed.
 */
function nodeVerdictFor(node: AutopilotNode, acId: string): { verdict: Verdict; notes?: string } {
  let verdict: Verdict;
  let notes: string | undefined;
  if (node.status === 'failed') {
    verdict = 'fail';
    notes = 'an addressing node failed';
  } else if (node.status === 'passed' && hasClosingEvidence(node, acId)) {
    verdict = 'pass';
  } else if (node.status === 'passed') {
    verdict = 'unverified';
    notes = 'addressing node passed without evidence (claim ≠ proof)';
  } else {
    verdict = 'unverified';
    notes = 'addressing node not terminal';
  }
  for (const e of node.ac_verdicts.filter((v) => v.criterion_id === acId)) {
    const folded = worst(verdict, e.verdict);
    if (SEVERITY[folded] < SEVERITY[verdict]) {
      verdict = folded;
      notes =
        e.notes ?? `verifier judged ${acId} ${e.verdict} (per-AC verdict caps the node-level pass)`;
    }
  }
  return { verdict, ...(notes ? { notes } : {}) };
}

/**
 * Does `node` transitively depend on a PASSED `fix` node? A re-verify that runs
 * *after* a fix landed (depends on it) is allowed to supersede an earlier fail
 * for the same AC — that is the find→fix→reverify convergence. A passing node
 * that does NOT sit behind a fix is just a parallel/earlier verification and
 * cannot mask a sibling fail (preserves the worst() false-green protection).
 * DFS over depends_on with a recursion-stack guard (cycles are rejected at
 * graph-mutation time, but guard defensively so a malformed graph can't loop).
 */
function dependsOnPassedFix(node: AutopilotNode, byId: Map<string, AutopilotNode>): boolean {
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const cur = byId.get(id);
    if (!cur) return false;
    for (const dep of cur.depends_on) {
      const depNode = byId.get(dep);
      if (depNode && depNode.kind === 'fix' && depNode.status === 'passed') return true;
      if (visit(dep)) return true;
    }
    return false;
  };
  return visit(node.id);
}

/** Does `node` transitively depend on `targetId`? Same guarded DFS over depends_on. */
function dependsOnNode(
  node: AutopilotNode,
  targetId: string,
  byId: Map<string, AutopilotNode>,
): boolean {
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const cur = byId.get(id);
    if (!cur) return false;
    for (const dep of cur.depends_on) {
      if (dep === targetId) return true;
      if (visit(dep)) return true;
    }
    return false;
  };
  return visit(node.id);
}

/**
 * Is this node's `unverified` for `acId` purely STRUCTURAL — a passed node that
 * simply carries no evidence (and no explicit per-AC judgment below pass)? Such
 * an unverified is "implementation done, proof lives elsewhere", as opposed to
 * an explicit verifier judgment or unfinished work, which must stick.
 */
function isStructuralUnverified(node: AutopilotNode, acId: string): boolean {
  return (
    node.status === 'passed' &&
    !hasClosingEvidence(node, acId) &&
    node.ac_verdicts.every((v) => v.criterion_id !== acId || v.verdict === 'pass')
  );
}

export function deriveAcVerdicts(graph: Autopilot, acIds: string[]): DerivedVerdict[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return acIds.map((acId) => {
    const addressing = graph.nodes.filter((n) => n.acceptance_refs.includes(acId));
    // Evidence closing this AC = top-level evidence on every addressing node PLUS
    // any per-AC evidence those nodes attached to *this* criterion (wi_260622kb4).
    const evidence = addressing.flatMap((n) => [...n.evidence_refs, ...perAcEvidence(n, acId)]);

    if (addressing.length === 0) {
      return {
        criterion_id: acId,
        verdict: 'unverified' as const,
        evidence,
        notes: 'no node addressed this criterion',
      };
    }

    // Per-node verdicts for this AC. Supersession: a later re-verify node that
    // PASSES this AC *and* transitively depends on a passed fix node cancels any
    // earlier non-pass (fail OR partial) for the same AC (find→fix→reverify
    // converged). A pass that is NOT behind a fix cannot supersede — so an unfixed
    // fail/partial still wins (no false-green). After supersession, fold the
    // survivors with worst().
    const supersedingFix = addressing.some(
      (n) => nodeVerdictFor(n, acId).verdict === 'pass' && dependsOnPassedFix(n, byId),
    );

    let verdict: Verdict = 'pass';
    let notes: string | undefined;
    let folded = false;
    let structuralSuperseded = false;
    for (const n of addressing) {
      const nv = nodeVerdictFor(n, acId);
      // A non-pass (fail OR partial) that a later fix-backed re-verify supersedes
      // is dropped from the fold — a pre-fix verification snapshot, like an earlier
      // fail, must not drag down an AC the fix-backed re-verify has since passed.
      if ((nv.verdict === 'fail' || nv.verdict === 'partial') && supersedingFix) continue;
      // gotcha #3 (wi_260610idf): an implementation node's evidence-less pass is
      // a STRUCTURAL unverified, not a judgment. When another addressing node
      // DOWNSTREAM of it (transitively depends on it) passed this AC with
      // evidence, that verification ran after — and therefore covers — the
      // implementation, so the structural unverified is dropped from the fold.
      // Explicit per-AC non-pass verdicts, non-terminal nodes, fails, parallel/
      // earlier passes, and a node's own per-AC pass are never superseded.
      // BUG2 (wi_2606144ta): a `design`/planner node is a GENERATOR — upstream of
      // all real work by construction — so any addressing node that verified this
      // AC inherently ran after it; the downstream-dependency edge is not required.
      // (A planner can emit a subgraph whose root does not depend on the seed
      // design node, which would otherwise leave its all-AC structural unverified
      // unsuperseded and fold every AC to unverified.) Non-generator (implement)
      // nodes keep the ordering requirement so a parallel/earlier pass can't mask
      // them (preserves the gotcha #3 false-green protection).
      if (
        nv.verdict === 'unverified' &&
        isStructuralUnverified(n, acId) &&
        addressing.some(
          (m) =>
            m !== n &&
            nodeVerdictFor(m, acId).verdict === 'pass' &&
            (n.kind === 'design' || dependsOnNode(m, n.id, byId)),
        )
      ) {
        structuralSuperseded = true;
        continue;
      }
      const next = worst(verdict, nv.verdict);
      if (!folded || SEVERITY[next] < SEVERITY[verdict]) {
        verdict = next;
        notes = nv.notes;
        folded = true;
      }
    }
    if (supersedingFix && verdict === 'pass') {
      notes = `earlier non-pass superseded by a re-verify behind a passed fix (${acId})`;
    } else if (structuralSuperseded && verdict === 'pass') {
      notes = `evidence-less implementation pass covered by a downstream verified pass (${acId})`;
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
