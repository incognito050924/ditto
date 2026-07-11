import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';
import type { CompletionContract } from '~/schemas/completion-contract';
import type { AcOracle, AcceptanceCriterion, WorkItem } from '~/schemas/work-item';
import { allNodesTerminal } from './autopilot-driver';
import { selectReadyNodes } from './autopilot-graph';
import { type AutopilotDecision, synthesizeDecisionId } from './autopilot-store';
import { type CompletionInput, buildCompletion } from './completion-store';
import {
  type AcAttestation,
  type FrozenTestEntry,
  assertFrozenTestsIntact,
  attestAcVerdicts,
  oracleSatisfaction,
} from './gates';

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
    //
    // ac-4 (wi_260710vzu): the drop is ORDERING-GATED PER failed node — a passing
    // node `m` supersedes `n`'s non-pass ONLY when `m` (i) transitively depends on a
    // passed fix AND (ii) transitively depends on `n` itself, so `m` demonstrably ran
    // AFTER `n`'s failure and behind the fix that addresses it. A GLOBAL "some pass is
    // fix-backed" boolean is unsound: an EARLIER fix-backed pass would launder a LATER
    // genuine fail discovered downstream of it (false-green). Fail-safe / over-block:
    // any non-pass with no fix-backed pass downstream of it sticks, so a fail→pass wash
    // cannot empty the parked set deriveNonPassStatus reads → the D1 termination gate is
    // never bypassed. Reuses dependsOnPassedFix + dependsOnNode (no new ordering logic).
    const supersededByFixBackedReverify = (n: AutopilotNode): boolean =>
      addressing.some(
        (m) =>
          m !== n &&
          nodeVerdictFor(m, acId, oracle).verdict === 'pass' &&
          dependsOnPassedFix(m, byId) &&
          dependsOnNode(m, n.id, byId),
      );

    let verdict: Verdict = 'pass';
    let notes: string | undefined;
    let folded = false;
    let structuralSuperseded = false;
    let fixSuperseded = false;
    for (const n of addressing) {
      const nv = nodeVerdictFor(n, acId, oracle);
      // A non-pass (fail OR partial) that a fix-backed re-verify DOWNSTREAM of this node
      // supersedes is dropped from the fold — a pre-fix verification snapshot, like an
      // earlier fail, must not drag down an AC the fix-backed re-verify has since passed.
      if ((nv.verdict === 'fail' || nv.verdict === 'partial') && supersededByFixBackedReverify(n)) {
        fixSuperseded = true;
        continue;
      }
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
    if (fixSuperseded && verdict === 'pass') {
      notes = `earlier non-pass superseded by a fix-backed re-verify downstream of it (${acId})`;
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

/**
 * wi_260709sq3: the recipe `barrier_opt_out` opt-out. When true, an absent/no-command
 * DEGRADED barrier (passed as a node WITHOUT command evidence — it could not execute the
 * suite) is NOT-APPLICABLE: its `unverified` entry is SUPPRESSED, so `deriveFinalVerdict`
 * lets the ACs alone decide (a project that intentionally relies on push_gate/CI is not
 * chronically floored). The opt-out affects ONLY the no-command DEGRADE path — it never
 * suppresses a barrier that RAN and is `failed` (`status==='failed'`, a REAL failure) nor
 * a non-terminal barrier, so it can never convert a barrier failure into a pass
 * (false-green guard). Absent/false ⇒ the FLOOR default (a merely-absent barrier still
 * floors — the safe default catches "forgot to declare one").
 */
function testBarrierUnverified(
  graph: Autopilot,
  barrierOptOut = false,
): NonNullable<CompletionInput['unverified']> {
  const barriers = graph.nodes.filter((n) => n.kind === 'test');
  if (barriers.length === 0) return []; // structural absence → grandfather (ac-1 part e)
  return (
    barriers
      .filter((b) => !barrierRanGreen(b))
      // Opt-out suppresses ONLY the no-command DEGRADE (passed WITHOUT command evidence);
      // a `failed` (RED) or non-terminal barrier is never suppressed. After the
      // `!barrierRanGreen` filter, `status==='passed'` ⟺ passed-without-command = degrade.
      .filter((b) => !(barrierOptOut && b.status === 'passed'))
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
      }))
  );
}

/**
 * wi_2607103tp ac-3 (M3): the phantom-red DEGRADE floor — the pre-approval mirror of
 * `testBarrierUnverified`. The phantom-red gate (autopilot-loop.ts) can return a
 * `degrade` verdict when an authored red test could not be deterministically confirmed
 * as an assertion-red (e.g. a non-bun runner — indeterminate). A degrade never fails
 * the `test-author` node (only `block` does), so without this floor a stack whose ACs
 * all fold to pass would be SILENTLY passed (false-green). The loop records that degrade
 * as a `note` evidence_ref carrying the `phantom-red-degrade` marker on the passed
 * `test-author` node; this scans for it and injects an IN-SCOPE `unverified` entry so
 * `deriveFinalVerdict` floors `final_verdict ≠ pass`. `phantomRedOptOut` (the DEDICATED
 * recipe `phantom_red_opt_out`, NOT `barrier_opt_out`) suppresses the floor. Absent/false
 * ⇒ the FLOOR default. Empty when no such degrade was recorded → byte-identical to the
 * no-degrade completion.
 */
const PHANTOM_RED_DEGRADE_MARKER = 'phantom-red-degrade';
function phantomRedUnverified(
  graph: Autopilot,
  phantomRedOptOut = false,
): NonNullable<CompletionInput['unverified']> {
  if (phantomRedOptOut) return [];
  return graph.nodes
    .filter(
      (n) =>
        n.status === 'passed' &&
        n.kind === 'test-author' &&
        n.evidence_refs.some(
          (e) => e.kind === 'note' && (e.summary ?? '').includes(PHANTOM_RED_DEGRADE_MARKER),
        ),
    )
    .map((n) => ({
      item: `phantom-red degrade on test-author node ${n.id}`,
      reason: `the authored phantom-red for test-author node ${n.id} DEGRADED (indeterminate — could not be deterministically confirmed as an assertion-red), so acceptance-criteria closure is unverified (ADR-0018: proceed but never claim pass)`,
      // IN-SCOPE (out_of_scope:false) so deriveFinalVerdict floors final_verdict≠pass.
      out_of_scope: false,
      // Tool/host-blocked class: the red could not be proven; grounding points at the node.
      resolvability: 'blocked_external' as const,
      grounding: n.id,
    }));
}

/**
 * wi_260710l33 (#24): the completion-boundary FROZEN-test breach floor — the
 * defense-in-depth mirror of the in-loop `assertFrozenTestsIntact` check
 * (autopilot-loop.ts). That in-loop check binds frozen integrity ONLY to a mutating
 * pass (implement/fix/refactor); a frozen red test breached OUT-OF-BAND *after* the
 * last mutating pass (deleted or edited by a later read-only pass or a separate
 * session) is never re-checked, so a `dynamic_test` AC that closed green could have
 * its proving test gutted while completion still folds to `final_verdict=pass`
 * (vacuous-green reopened at the boundary).
 *
 * This re-runs the SAME frozen integrity check at assembly against the frozen manifest
 * committed into the approval gate's `test_spec` (`test_backed`). `currentHash` is
 * INJECTED (same purity as the loop's check — the CLI re-hashes the files on disk), so
 * the function stays pure and unit-testable. Each BOUND entry (one carrying a
 * `frozen_hash`) whose current hash is MISSING (deleted) or DIFFERENT (weakened) yields
 * an IN-SCOPE `unverified` entry so `deriveFinalVerdict` floors `final_verdict ≠ pass`,
 * mirroring the barrier / phantom-red floors. An UNBOUND entry contributes no binding
 * (degrade, never a false reject — ADR-0018).
 *
 * `currentHash` ABSENT (no injection) ⇒ the floor cannot read the filesystem, so it is
 * INERT: empty output, byte-identical to the no-frozen completion. This keeps the
 * metrics-only assembly (autopilot-loop.ts) and every legacy caller unchanged — only
 * the CLI `autopilot complete` path (which injects the on-disk hashes) enforces it.
 */
function frozenBreachUnverified(
  graph: Autopilot,
  currentHash?: (test_path: string) => string | undefined,
): NonNullable<CompletionInput['unverified']> {
  if (!currentHash) return []; // no filesystem source injected ⇒ inert (backward compat)
  const manifest: readonly FrozenTestEntry[] =
    graph.approval_gate.plan_brief?.test_spec?.test_backed ?? [];
  const bound = manifest.filter((t) => t.frozen_hash !== undefined);
  if (bound.length === 0) return [];
  const intact = assertFrozenTestsIntact(bound, currentHash);
  if (intact.pass) return [];
  return intact.reasons.map((reason) => ({
    item: 'frozen-test integrity (completion boundary)',
    reason: `${reason} (re-checked at completion assembly — a breach after the last mutating pass reopens the vacuous-green hole; ADR-0018: proceed but never claim pass)`,
    // IN-SCOPE (out_of_scope:false) so deriveFinalVerdict floors final_verdict≠pass.
    out_of_scope: false,
    // agent-fixable: the frozen test must be restored (un-gut) or the AC re-derived.
    resolvability: 'agent_resolvable' as const,
    grounding: 'approval_gate.plan_brief.test_spec.test_backed',
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
  /**
   * wi_260709sq3: the resolved recipe `barrier_opt_out` flag. When true, an
   * absent/no-command DEGRADED test barrier is NOT-APPLICABLE (its floor `unverified`
   * is suppressed) so the ACs alone decide. Omitted ⇒ false ⇒ today's FLOOR default
   * (backward-compatible: existing callers/tests are unaffected). Only the no-command
   * degrade is suppressed — a barrier that RAN and FAILED still floors.
   */
  barrierOptOut?: boolean;
  /**
   * wi_2607103tp ac-3 (M3): the resolved recipe `phantom_red_opt_out` flag — DEDICATED
   * to the phantom-red degrade floor, INDEPENDENT of `barrierOptOut`. When true, a
   * recorded phantom-red DEGRADE is NOT-APPLICABLE (its floor `unverified` is suppressed)
   * so the ACs alone decide. Kept separate because `barrier_opt_out` is scoped to the
   * settled-tree barrier's no-command degrade; reusing it would silently suppress a
   * genuine bun-side phantom-red degrade. Omitted ⇒ false ⇒ the FLOOR default.
   */
  phantomRedOptOut?: boolean;
  /**
   * wi_260710l33 (#24): re-hash lookup for the completion-boundary frozen-breach floor.
   * The CLI `autopilot complete` injects a function that reads each frozen test's CURRENT
   * on-disk content hash (mirroring the loop's `hashAuthoredTest`), so the assembly can
   * re-run `assertFrozenTestsIntact` against the frozen manifest and floor final_verdict
   * off pass if a frozen red test was breached AFTER the last mutating pass. Omitted ⇒
   * the floor is INERT (no filesystem source) ⇒ byte-identical to the legacy completion,
   * so the metrics-only assembly and every existing caller/test are unaffected.
   */
  currentTestHash?: (test_path: string) => string | undefined;
  now?: Date;
}

/**
 * wi_260710676 (#18): the honest-terminate WRITER for `completion.non_pass_status`.
 * The Stop gate `nonPassTerminationGate` (gates.ts) lets a non-pass completion
 * terminate ONLY when it carries this declaration — but no code ever wrote it, so an
 * autopilot that honestly finished non-pass was blocked at its own gate and needed a
 * manual `completion.json` edit. Derive it from the SAME state the gate reads (the
 * parked = unverified/fail acceptance set), but ONLY when the graph has genuinely
 * SETTLED (`allNodesTerminal`, retro-exempt — the loop's own done condition). An
 * unfinished graph gets no declaration, so the gate keeps BLOCKING a no-progress park
 * (the exact protection the gate exists for — ADR-20260626 D2). Nothing parked (every
 * non-pass AC is a declared `partial`, an honest signal) → no declaration either, and
 * the gate already passes.
 *
 * `state`: `partial` when ≥1 AC reached pass (progress made), else `blocked` (nothing
 * achieved). A STUCK graph is `blocked` regardless of progress (see below). `grounding`
 * names the parked criterion ids — the oracle the gate points at.
 *
 * ac-1 (wi_260710tjd) blocked-graph deadlock fix: the settle guard is "the loop can
 * make no further progress", NOT "every node passed/failed". A NON-terminal graph the
 * loop cannot advance — no ready node, nothing running, ≥1 blocked node (the loop's
 * `action:'blocked'` condition, autopilot-loop.ts) — is a stuck run and gets an honest
 * `state:'blocked'` declaration, so the Stop gate lets it TERMINATE instead of
 * deadlocking (parked criteria + no declaration + no runnable node). A still-runnable /
 * running graph is NOT stuck and still gets NO declaration (ac-5 no-progress protection).
 */
function loopStuckBlocked(graph: Autopilot): boolean {
  if (selectReadyNodes(graph.nodes).length > 0) return false; // still a runnable node
  if (graph.nodes.some((n) => n.status === 'running')) return false; // transient progress
  return graph.nodes.some((n) => n.status === 'blocked'); // stuck on a blocked node
}

function deriveNonPassStatus(
  graph: Autopilot,
  acceptance: CompletionContract['acceptance'],
  finalVerdict: CompletionContract['final_verdict'],
): NonNullable<CompletionContract['non_pass_status']> | undefined {
  if (finalVerdict === 'pass') return undefined;
  const terminal = allNodesTerminal(graph);
  const stuck = !terminal && loopStuckBlocked(graph);
  if (!terminal && !stuck) return undefined;
  const parked = acceptance.filter((a) => a.verdict === 'unverified' || a.verdict === 'fail');
  if (parked.length === 0) return undefined;
  const parkedIds = parked.map((a) => a.criterion_id).join(', ');
  const progressed = acceptance.some((a) => a.verdict === 'pass');
  // A stuck (blocked) graph is `blocked` even if some AC reached pass — the loop cannot
  // proceed (mirrors the loop's disposition:'blocked'); a cleanly-settled terminal graph
  // is `partial` when progress was made, else `blocked`.
  return {
    state: stuck || !progressed ? 'blocked' : 'partial',
    reason: stuck
      ? `autopilot cannot proceed (graph blocked, no runnable node) with ${parked.length} criterion/criteria not reaching pass: ${parkedIds}`
      : `autopilot terminated non-pass with ${parked.length} criterion/criteria not reaching pass: ${parkedIds}`,
    grounding: `parked acceptance criteria: ${parkedIds}`,
  };
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
  const barrierUnverified = testBarrierUnverified(graph, opts.barrierOptOut ?? false);
  // wi_2607103tp ac-3 (M3): the phantom-red degrade floor, merged alongside the barrier
  // floor (independent opt-out). Both are IN-SCOPE unverified entries that floor the verdict.
  const phantomUnverified = phantomRedUnverified(graph, opts.phantomRedOptOut ?? false);
  // wi_260710l33 (#24): the completion-boundary frozen-breach floor, merged alongside the
  // barrier / phantom-red floors. Inert unless the caller injects `currentTestHash` (the
  // CLI re-hashes the frozen tests on disk) — so a legacy/metrics-only assembly is
  // byte-identical. IN-SCOPE unverified ⇒ deriveFinalVerdict floors final_verdict≠pass.
  const frozenUnverified = frozenBreachUnverified(graph, opts.currentTestHash);
  const floorUnverified = [...barrierUnverified, ...phantomUnverified, ...frozenUnverified];
  const built = buildCompletion({
    workItem,
    declaredBy: 'verifier',
    summary,
    verdicts,
    ...(remainingRisks.length > 0 ? { remainingRisks } : {}),
    ...(floorUnverified.length > 0 ? { unverified: floorUnverified } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  // ac-3 producer: project unresolved agent_resolvable risks from the ledger into the
  // structured `remaining_risk_records` surface (additive — the field is optional, so a
  // no-record assembly round-trips byte-identical to the legacy shape).
  const riskRecords = opts.decisions
    ? unresolvedAgentResolvableRiskRecords(opts.decisions, graph)
    : [];
  const withRecords =
    riskRecords.length > 0 ? { ...built, remaining_risk_records: riskRecords } : built;
  // wi_260710676 (#18): attach the honest non-pass declaration so a settled non-pass
  // run terminates at the Stop gate instead of demanding a manual completion.json edit.
  const nonPassStatus = deriveNonPassStatus(
    graph,
    withRecords.acceptance,
    withRecords.final_verdict,
  );
  return nonPassStatus ? { ...withRecords, non_pass_status: nonPassStatus } : withRecords;
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
