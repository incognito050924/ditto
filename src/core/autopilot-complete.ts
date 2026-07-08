import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';
import type { CompletionContract } from '~/schemas/completion-contract';
import type { AcOracle, AcceptanceCriterion, WorkItem } from '~/schemas/work-item';
import { type AutopilotDecision, synthesizeDecisionId } from './autopilot-store';
import { type CompletionInput, buildCompletion } from './completion-store';
import { type AcAttestation, attestAcVerdicts, oracleSatisfaction } from './gates';

/** Per-AC oracle lookup threaded into the closure decision (ADR-0024 §3 ③ JUDGE). */
type OracleMap = ReadonlyMap<string, AcOracle | undefined>;

/**
 * Per-AC work-item criterion state (verdict + recorded evidence) threaded into the
 * closure so a fresh `ditto verify` pass — recorded on the WORK-ITEM criterion AFTER
 * the autopilot run — can supersede a stale node verdict (wi_2607074rs). Only the two
 * fields the reconciliation reads are required.
 */
type CriterionEvidenceMap = ReadonlyMap<string, Pick<AcceptanceCriterion, 'verdict' | 'evidence'>>;

/**
 * Does a work-item criterion carry EVIDENCE-BACKED proof — i.e. a command-kind
 * evidence entry, the shape `ditto verify --criterion` records (verify.ts) and the
 * SAME "REAL evidence" bar push-readiness enforces (work-item-store.pushReadiness).
 * A bare/placeholder pass (verdict flipped to `pass` with no command evidence) does
 * NOT qualify — this is the false-green guard: only a real verify supersedes a node
 * verdict, never a claim.
 */
function hasVerifyEvidence(criterion: Pick<AcceptanceCriterion, 'evidence'>): boolean {
  return criterion.evidence.some((e) => e.kind === 'command');
}

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

/** Evidence that closes `acId` on `node` (top-level ∪ per-AC), the union the oracle gate reads. */
function closingEvidence(node: AutopilotNode, acId: string) {
  return [...node.evidence_refs, ...perAcEvidence(node, acId)];
}

/**
 * The verdict a single addressing node contributes for ONE criterion: its
 * evidence-gated structural verdict (status + evidence) lowered by any per-AC
 * verdict that node emitted for this criterion. This is the old flat fold,
 * evaluated per node so supersession can reason about *which* node failed vs.
 * which later node re-passed.
 *
 * ADR-0024 §3 ③ JUDGE (ac-4): when an oracle IS present for `acId`, a would-be
 * `pass` close is held to that oracle — if the recorded closing evidence does not
 * meet the oracle (e.g. a static_scan with only a note, no recorded re-scan), the
 * node's contribution is downgraded to `unverified` (NOT pass) with a reason note
 * naming the AC + unmet oracle. fail-closed: any throw while evaluating the oracle
 * also downgrades (over-block, never a false pass). An ABSENT oracle leaves the
 * exact prior behavior (presence-gated, regression-safe).
 */
function nodeVerdictFor(
  node: AutopilotNode,
  acId: string,
  oracle?: AcOracle,
): { verdict: Verdict; notes?: string } {
  let verdict: Verdict;
  let notes: string | undefined;
  if (node.status === 'failed') {
    verdict = 'fail';
    notes = 'an addressing node failed';
  } else if (node.status === 'passed' && hasClosingEvidence(node, acId)) {
    if (oracle) {
      let blocked: string | undefined;
      try {
        const sat = oracleSatisfaction(acId, oracle, closingEvidence(node, acId));
        if (!sat.pass) blocked = sat.reasons[0];
      } catch {
        // fail-closed: an oracle/anchor evaluation error never yields a silent pass.
        blocked = `${acId}: ${oracle.verification_method} oracle evaluation errored (held non-pass, fail-closed)`;
      }
      if (blocked) {
        verdict = 'unverified';
        notes = blocked;
      } else {
        verdict = 'pass';
      }
    } else {
      verdict = 'pass';
    }
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

export function deriveAcVerdicts(
  graph: Autopilot,
  acIds: string[],
  oracles?: OracleMap,
  criteria?: CriterionEvidenceMap,
): DerivedVerdict[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return acIds.map((acId) => {
    // Presence-gated: only an AC that carries an oracle gets the new closure check;
    // absent → the exact prior behavior (regression-safe, ADR-0024 ac-4).
    const oracle = oracles?.get(acId);
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
      (n) => nodeVerdictFor(n, acId, oracle).verdict === 'pass' && dependsOnPassedFix(n, byId),
    );

    let verdict: Verdict = 'pass';
    let notes: string | undefined;
    let folded = false;
    let structuralSuperseded = false;
    for (const n of addressing) {
      const nv = nodeVerdictFor(n, acId, oracle);
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
            nodeVerdictFor(m, acId, oracle).verdict === 'pass' &&
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

    // wi_2607074rs: reconcile with the WORK-ITEM criterion, which is strictly FRESHER
    // than the graph — a `ditto verify` pass is recorded AFTER the autopilot run. When
    // the criterion carries an EVIDENCE-BACKED pass (command-kind evidence, the
    // `ditto verify` shape / the push-readiness "REAL evidence" bar), it SUPERSEDES a
    // stale node non-pass so a genuinely re-verified WI can close. False-green guard: a
    // bare/placeholder criterion pass (no command evidence) is powerless — it can never
    // override a node fail; only a real, evidence-backed verify supersedes (claim ≠ proof).
    let finalEvidence = evidence;
    const criterion = criteria?.get(acId);
    if (
      verdict !== 'pass' &&
      criterion &&
      criterion.verdict === 'pass' &&
      hasVerifyEvidence(criterion)
    ) {
      verdict = 'pass';
      notes = `stale node verdict superseded by a fresh evidence-backed \`ditto verify\` pass (${acId})`;
      // Carry the verify evidence into the derived verdict so the mirror-back
      // (mirrorAcceptanceVerdicts) preserves the command-kind proof rather than
      // overwriting the criterion with evidence-thin node refs.
      finalEvidence = [...evidence, ...criterion.evidence];
    }

    return { criterion_id: acId, verdict, evidence: finalEvidence, ...(notes ? { notes } : {}) };
  });
}

/** One structured residual-risk record (ac-3) as carried on the completion contract. */
type RemainingRiskRecords = NonNullable<CompletionContract['remaining_risk_records']>;

/**
 * ac-3 (T1) completion-side PRODUCER. The agent_resolvable residual risks the loop
 * AUTO-ROUTED to a forward fix round (`auto_fix` decisions, resolvability
 * `agent_resolvable`) but whose re-verify did NOT converge — i.e. the risk was NOT
 * actually resolved by completion-assembly time. Such a risk must reach the
 * completion's structured `remaining_risk_records[]` so the Stop gate's
 * `riskRecordBlockers` can block on it: an unhandled auto-resolvable risk cannot
 * silently leak through completion. A risk IS resolved — and therefore NOT re-recorded
 * (the finding's "resolved/auto-fixed ones not re-recorded") — when a spliced re-verify
 * recheck for its node PASSED (the `<node>.rev.r<k>` recheck the auto-fix splice
 * introduced; planForwardReexpansion naming). Pure: reads ONLY the append-only ledger
 * + the final graph, never re-derives. Dedups by risk text.
 */
export function unresolvedAgentResolvableRiskRecords(
  decisions: readonly AutopilotDecision[],
  graph: Autopilot,
): RemainingRiskRecords {
  const records: RemainingRiskRecords = [];
  const seen = new Set<string>();
  for (const d of decisions) {
    if (d.decision !== 'auto_fix' || d.resolvability !== 'agent_resolvable') continue;
    // Resolved iff a spliced re-verify recheck for this node passed.
    const recheckPassed = graph.nodes.some(
      (n) => n.id.startsWith(`${d.node_id}.rev.`) && n.status === 'passed',
    );
    if (recheckPassed) continue;
    const risk = d.reason.replace(/^auto-fix residual risk: /, '');
    if (seen.has(risk)) continue;
    seen.add(risk);
    records.push({ risk, resolvability: 'agent_resolvable' });
  }
  return records;
}

/**
 * Settled-tree TEST BARRIER completion seam (wi_260708ds9 ac-1, the load-bearing
 * one). A `test` barrier node carries acceptance_refs:[], so it never contributes a
 * per-AC verdict — deriveAcVerdicts folds it away. Yet its disposition MUST be AND'd
 * into the final verdict, else a graph whose per-AC oracles all pass folds to
 * final_verdict=pass while the suite never actually ran GREEN (false-green).
 *
 * The `unverified[]` entry is the seam: deriveFinalVerdict floors final_verdict≠pass
 * whenever an IN-SCOPE unverified item remains, so injecting one for any barrier that
 * is NOT proven-green makes completion honest (ADR-0018 — never claim pass when the
 * suite did not run green) without giving the barrier acceptance_refs=all (which would
 * spring the structural-unverified supersession trap → permanent deadlock).
 *
 * A barrier is proven-GREEN only when it PASSED as a node AND carries command-kind
 * evidence (the `bun test` run — the same "REAL evidence" bar hasVerifyEvidence keys
 * on). Any other present barrier disposition floors the verdict:
 *  - RED (status=failed): the suite is red — a hard non-pass (also caught at the loop
 *    via all_passed=false, but the completion path must be honest independently).
 *  - DEGRADE (passed but no command evidence — it could not execute the suite): it
 *    PROCEEDS as a node (never blocks), but completion records the tests-never-ran gap.
 *  - non-terminal (pending/running/blocked): the barrier has not settled.
 *
 * STRUCTURAL ABSENCE (zero `test` nodes = a pre-barrier legacy graph) yields NO entry
 * — the grandfathered AC-only completion, so the 30+ in-flight legacy graphs never
 * deadlock (migration-safe). Only a PRESENT non-green barrier floors the verdict.
 */
function barrierRanGreen(node: AutopilotNode): boolean {
  return node.status === 'passed' && node.evidence_refs.some((e) => e.kind === 'command');
}

function testBarrierUnverified(graph: Autopilot): NonNullable<CompletionInput['unverified']> {
  const barriers = graph.nodes.filter((n) => n.kind === 'test');
  if (barriers.length === 0) return []; // structural absence → grandfather (ac-1 part e)
  return barriers
    .filter((b) => !barrierRanGreen(b))
    .map((b) => ({
      item: `settled-tree test barrier ${b.id}`,
      reason:
        b.status === 'failed'
          ? `the settled-tree test barrier (${b.id}) is RED — the suite failed, so acceptance-criteria closure is not proven`
          : `the settled-tree test barrier (${b.id}) did not run GREEN (degraded / not executed / non-terminal) — the suite never proved green, so acceptance-criteria closure is unverified (ADR-0018: proceed but never claim pass)`,
      // IN-SCOPE (out_of_scope:false) so deriveFinalVerdict floors final_verdict≠pass.
      out_of_scope: false,
      // Tool/host-blocked class: the suite could not be proven green. The gate reads
      // this label; grounding points at the barrier node.
      resolvability: 'blocked_external' as const,
      grounding: b.id,
    }));
}

export interface AssembleOptions {
  /** Operator/verifier narrative; a terse default is derived when omitted. */
  summary?: string;
  remainingRisks?: string[];
  /**
   * The loop's append-only decision ledger. When threaded, the assembly projects any
   * UNRESOLVED agent_resolvable risk (auto-routed but its re-verify did not converge)
   * into `remaining_risk_records` so the Stop gate can block on it (ac-3 producer).
   * Absent ⇒ no records emitted (legacy completion shape, backward compat).
   */
  decisions?: readonly AutopilotDecision[];
  now?: Date;
}

export function assembleCompletionFromGraph(
  graph: Autopilot,
  workItem: WorkItem,
  opts: AssembleOptions = {},
): CompletionContract {
  const acIds = workItem.acceptance_criteria.map((c) => c.id);
  // ADR-0024 §3 ③ JUDGE: thread each AC's oracle (if any) into the closure
  // decision. Absent oracle → prior evidence-gated behavior (presence-gated).
  const oracles: OracleMap = new Map(workItem.acceptance_criteria.map((c) => [c.id, c.oracle]));
  // wi_2607074rs: thread each AC's own criterion state so a fresh evidence-backed
  // `ditto verify` pass (recorded after the run) supersedes a stale node verdict.
  const criteria: CriterionEvidenceMap = new Map(
    workItem.acceptance_criteria.map((c) => [c.id, c]),
  );
  const verdicts = deriveAcVerdicts(graph, acIds, oracles, criteria);
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
  // Settled-tree test barrier seam (ac-1 part d): AND the barrier's GREEN/RED/degrade
  // disposition into the final verdict via an IN-SCOPE unverified entry. Empty on a
  // green barrier OR structural absence (legacy grandfather) → byte-identical to the
  // no-barrier completion.
  const barrierUnverified = testBarrierUnverified(graph);
  const built = buildCompletion({
    workItem,
    declaredBy: 'verifier',
    summary,
    verdicts,
    ...(remainingRisks.length > 0 ? { remainingRisks } : {}),
    ...(barrierUnverified.length > 0 ? { unverified: barrierUnverified } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  // ac-3 producer: project unresolved agent_resolvable risks from the ledger into the
  // structured `remaining_risk_records` surface (additive — the field is optional, so a
  // no-record assembly round-trips byte-identical to the legacy shape).
  const riskRecords = opts.decisions
    ? unresolvedAgentResolvableRiskRecords(opts.decisions, graph)
    : [];
  return riskRecords.length > 0 ? { ...built, remaining_risk_records: riskRecords } : built;
}

/**
 * ac-6 (T1): the positive per-AC attestation at run termination, built from the
 * SAME derived verdicts the completion was assembled from. `completion.acceptance`
 * IS the projection of `deriveAcVerdicts` (verdict + notes) that
 * `assembleCompletionFromGraph` wrote, so reading it here — rather than recomputing
 * a parallel verdict — keeps the gate↔score invariant (charter §2): a
 * `verified-by-evidence` attestation can never disagree with the verdict that
 * closed the AC. `attestAcVerdicts` (gates.ts) folds the 4 verdicts into the 3
 * attestation states; ids/order are preserved 1:1.
 */
export function attestCompletion(completion: CompletionContract): AcAttestation[] {
  return attestAcVerdicts(
    completion.acceptance.map((a) => ({
      criterion_id: a.criterion_id,
      verdict: a.verdict,
      // Conditional spread: an absent note must not land as `notes: undefined`
      // (exactOptionalPropertyTypes), so the basis is carried only when present.
      ...(a.notes !== undefined ? { notes: a.notes } : {}),
    })),
  );
}

/** A single auto-handling decision projected from the loop's decision log (ac-6). */
export interface AutoHandlingEntry {
  node_id: string;
  decision: 'auto_fix' | 'surface' | 'batch_escalate';
  /** The resolvability reason-category the loop attributed (machine-attributable, ac-3). */
  resolvability?: AutopilotDecision['resolvability'];
  reason: string;
}

/**
 * The auto-handling ledger surfaced at run termination (ac-6). Each bucket is a
 * pure projection of the loop's append-only decision log — NOT a re-derivation:
 *  - `auto_fixed`   ← `auto_fix` decisions (a risk the loop auto-routed to a forward
 *    fix round; resolvability `agent_resolvable`);
 *  - `surfaced`     ← `surface` decisions (a residual surfaced IN-FLOW without
 *    terminating — one of the four surface classes or an R5 tool-blocked
 *    `blocked_external`);
 *  - `materialized` ← `batch_escalate` decisions (out-of-scope follow-ups signalled
 *    for separate materialization; resolvability `out_of_scope`).
 * Empty buckets when nothing was auto-handled.
 */
export interface AutoHandlingLedger {
  auto_fixed: AutoHandlingEntry[];
  surfaced: AutoHandlingEntry[];
  materialized: AutoHandlingEntry[];
}

/**
 * Project the loop's structured auto-handling decisions (`auto_fix` / `surface` /
 * `batch_escalate`, each carrying its resolvability category) into the completion's
 * auto-handling ledger. The loop (n1i-loop) already WRITES these entries; this only
 * reads and groups them (charter §4-11: do not duplicate / re-derive). Every other
 * decision kind (e.g. `loop_terminated`, `escalate`, `e2e_*`) is ignored.
 */
export function projectAutoHandling(decisions: readonly AutopilotDecision[]): AutoHandlingLedger {
  const ledger: AutoHandlingLedger = { auto_fixed: [], surfaced: [], materialized: [] };
  for (const d of decisions) {
    if (d.decision !== 'auto_fix' && d.decision !== 'surface' && d.decision !== 'batch_escalate') {
      continue;
    }
    const entry: AutoHandlingEntry = {
      node_id: d.node_id,
      decision: d.decision,
      ...(d.resolvability ? { resolvability: d.resolvability } : {}),
      reason: d.reason,
    };
    if (d.decision === 'auto_fix') ledger.auto_fixed.push(entry);
    else if (d.decision === 'surface') ledger.surfaced.push(entry);
    else ledger.materialized.push(entry);
  }
  return ledger;
}

/**
 * One autonomous direction-fork decision projected for the completion report (ac-4).
 * The DEDICATED disclosure section — separate from `projectAutoHandling`, which only
 * admits auto_fix/surface/batch_escalate — carries the four ac-4 fields verbatim from
 * the decision's `direction_record`: 무엇때문에 (`trigger`) · 선택지 (`options`) ·
 * 선택+의도근거 (`choice` + `intent_basis`) · 파급/되돌리기비용 (`blast_radius` +
 * `reverse_cost`). `decision_id` is the append-positional handle `ditto autopilot
 * revise --decision` targets (ac-5); `fork_node_id` is the anchor it re-drives from.
 */
export interface DirectionDecisionEntry {
  /** Append-positional decision handle (synthesizeDecisionId) — `revise` targets this. */
  decision_id: string;
  node_id: string;
  fork_node_id: string;
  /** 무엇때문에 — what triggered the autonomous fork. */
  trigger: string;
  /** 선택지 — the options the loop weighed. */
  options: string[];
  /** 선택 — the direction chosen. */
  choice: string;
  /** 의도근거 — why that choice advances the frozen purpose. */
  intent_basis: string;
  /** 파급 — the blast radius the fork touches. */
  blast_radius: string;
  /** 되돌리기비용 — the cost to reverse it. */
  reverse_cost: string;
  reason: string;
}

/**
 * Project the loop's `direction` decisions into the dedicated direction ledger (ac-4).
 * A pure projection of the append-only log — NOT a re-derivation (charter §4-11): the
 * loop already WROTE each `direction_record`; this only reads, indexes (for the stable
 * `decision_id` handle) and reshapes. A `direction` decision missing its structured
 * `direction_record` is skipped (defensive — the record is where the disclosure lives).
 * Every non-direction decision kind is ignored (auto-handling lives in its own ledger).
 */
export function projectDirectionDecisions(
  decisions: readonly AutopilotDecision[],
): DirectionDecisionEntry[] {
  const entries: DirectionDecisionEntry[] = [];
  decisions.forEach((d, index) => {
    if (d.decision !== 'direction') return;
    const record = d.direction_record;
    if (!record) return;
    entries.push({
      decision_id: synthesizeDecisionId(d, index),
      node_id: d.node_id,
      fork_node_id: record.fork_node_id,
      trigger: record.trigger,
      options: record.options,
      choice: record.choice,
      intent_basis: record.intent_basis,
      blast_radius: record.blast_radius,
      reverse_cost: record.reverse_cost,
      reason: d.reason,
    });
  });
  return entries;
}
