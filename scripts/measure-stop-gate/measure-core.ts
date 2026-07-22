/**
 * Pure-core latency + judgment measurement for the two completion-gate paths
 * (standalone harness, NOT part of the bun test suite).
 *
 * Paths under measurement:
 *  - rebuild: `evaluateStopGate` (rebuild/hook/stop-gate.ts) — pure decision.
 *  - src: `assembleCompletionFromGraph` (src/core/autopilot-complete.ts) — the
 *    PRODUCTION-SHAPE composition of `deriveAcVerdicts` + `buildCompletion`
 *    (plus the floor projections: test-barrier / phantom-red / frozen-breach),
 *    called exactly as the CLI completion path calls it. A second metric times
 *    the bare `deriveAcVerdicts` + `buildCompletion` pair (no floors) for the
 *    narrower two-function figure.
 *
 * Timing discipline:
 *  - monotonic clock: Bun.nanoseconds() (Date.now forbidden — 1ms resolution
 *    collapses a µs-scale measurement).
 *  - one sample = mean of K inner reps, timed as a batch; validation of every
 *    produced result happens OUTSIDE the timed window (per-run positive signal
 *    without polluting the timing).
 *  - warmup batches are run and DISCARDED from stats (recorded separately);
 *    the very first batch (pre-warmup) is reported as the cold estimate.
 */

import { type StopGateDecision, evaluateStopGate } from '../../rebuild/hook/stop-gate';
import { acsClaimingPassWithoutEvidence, pendingCount } from '../../rebuild/state/queue-state';
import { assembleCompletionFromGraph, deriveAcVerdicts } from '../../src/core/autopilot-complete';
import { buildCompletion } from '../../src/core/completion-store';
import type { CompletionContract } from '../../src/schemas/completion-contract';
import type { FixturePair } from './fixtures';
import { type StatSummary, summarize } from './stats';

export interface CoreTimingConfig {
  samples: number; // N (>= 30 for the reported stats)
  innerReps: number; // K per sample
  warmupBatches: number;
}

export const DEFAULT_CORE_TIMING: CoreTimingConfig = {
  samples: 30,
  innerReps: 20,
  warmupBatches: 5,
};

/**
 * Time `fn` and validate EVERY produced result (positive signal: the gate was
 * actually evaluated, not silently skipped). Returns stats + the count of valid
 * evaluations (valid_n). A validation failure throws — an unevaluated gate would
 * make the whole baseline fake (critical guard).
 */
export function measureCallable<T>(
  fn: () => T,
  validate: (result: T) => string | null,
  cfg: CoreTimingConfig,
): { stats: StatSummary; valid_n: number } {
  let validCount = 0;
  const results: T[] = new Array(cfg.innerReps);

  const oneBatch = (): number => {
    const t0 = Bun.nanoseconds();
    for (let i = 0; i < cfg.innerReps; i++) results[i] = fn();
    const t1 = Bun.nanoseconds();
    // validate outside the timed window
    for (let i = 0; i < cfg.innerReps; i++) {
      const err = validate(results[i] as T);
      if (err !== null) {
        throw new Error(`positive-signal validation failed (gate not really evaluated): ${err}`);
      }
      validCount++;
    }
    return (t1 - t0) / cfg.innerReps;
  };

  const coldFirstSample = oneBatch();
  const warmupSamples: number[] = [];
  for (let w = 0; w < cfg.warmupBatches; w++) warmupSamples.push(oneBatch());
  const warm: number[] = [];
  for (let s = 0; s < cfg.samples; s++) warm.push(oneBatch());

  return {
    stats: summarize(warm, { innerReps: cfg.innerReps, coldFirstSample, warmupSamples }),
    valid_n: validCount,
  };
}

/* -------------------------------- rebuild core -------------------------------- */

export function rebuildDecide(pair: FixturePair): StopGateDecision {
  return evaluateStopGate({
    testExitCode: pair.rebuild.testExitCode,
    state: pair.rebuild.state,
    foundationCompleteEmitted: pair.rebuild.foundationCompleteEmitted,
    stopHookActive: false,
  });
}

export function rebuildDecideStratified(
  pair: FixturePair,
  stopHookActive: boolean,
): StopGateDecision {
  return evaluateStopGate({
    testExitCode: pair.rebuild.testExitCode,
    state: pair.rebuild.state,
    foundationCompleteEmitted: pair.rebuild.foundationCompleteEmitted,
    stopHookActive,
  });
}

/** Positive-signal validator for the rebuild decision. */
export function validateRebuildDecision(pair: FixturePair) {
  return (d: StopGateDecision): string | null => {
    if (d.exitCode !== 0 && d.exitCode !== 2) return `exitCode out of contract: ${d.exitCode}`;
    if (d.exitCode === 2 && d.reasons.length === 0) {
      return 'block decision with EMPTY reasons — evaluation not evidenced';
    }
    if (d.exitCode === 0 && d.reasons.length !== 0) {
      return 'allow decision carrying reasons — inconsistent decision object';
    }
    // Cross-check against independently computed structural facts.
    const structuralBlock =
      pair.rebuild.testExitCode !== 0 ||
      pendingCount(pair.rebuild.state) > 0 ||
      acsClaimingPassWithoutEvidence(pair.rebuild.state).length > 0;
    if (structuralBlock !== (d.exitCode === 2)) {
      return `decision ${d.exitCode} disagrees with structural facts (block expected=${structuralBlock})`;
    }
    return null;
  };
}

/* ---------------------------------- src core ---------------------------------- */

/**
 * Production-shape src judgment: exactly what assembleCompletionFromGraph does —
 * it internally builds the oracle/criterion maps from the work item, calls
 * deriveAcVerdicts, injects the floor unverified entries and calls buildCompletion.
 */
export function srcAssemble(pair: FixturePair): CompletionContract {
  return assembleCompletionFromGraph(pair.src.graph, pair.src.workItem, {
    now: new Date('2026-07-22T00:00:00.000Z'),
  });
}

/**
 * The bare two-function figure: deriveAcVerdicts + buildCompletion with the SAME
 * production-shape arguments (oracle map + criterion map built as
 * assembleCompletionFromGraph builds them) but WITHOUT the floor projections —
 * reported separately so the floors' cost is visible by difference.
 */
export function srcDeriveBuild(pair: FixturePair): CompletionContract {
  const wi = pair.src.workItem;
  const acIds = wi.acceptance_criteria.map((c) => c.id);
  const oracles = new Map(wi.acceptance_criteria.map((c) => [c.id, c.oracle]));
  const criteria = new Map(wi.acceptance_criteria.map((c) => [c.id, c]));
  const verdicts = deriveAcVerdicts(pair.src.graph, acIds, oracles, criteria);
  return buildCompletion({
    workItem: wi,
    declaredBy: 'verifier',
    summary: 'measurement assembly (bare derive+build, no floor projections)',
    verdicts,
    now: new Date('2026-07-22T00:00:00.000Z'),
  });
}

/** Positive-signal validator for the src completion contract. */
export function validateSrcCompletion(pair: FixturePair) {
  return (c: CompletionContract): string | null => {
    if (c.acceptance.length !== pair.src.workItem.acceptance_criteria.length) {
      return `acceptance count ${c.acceptance.length} != AC count — judgment did not cover the criteria`;
    }
    if (!['pass', 'partial', 'fail', 'unverified'].includes(c.final_verdict)) {
      return `final_verdict out of contract: ${c.final_verdict}`;
    }
    // a non-pass completion must carry SOME structural signal (non-pass AC or
    // in-scope unverified entry) — a silent non-pass would be unexplained.
    if (c.final_verdict !== 'pass') {
      const anyNonPassAc = c.acceptance.some((a) => a.verdict !== 'pass');
      const anyInScopeUnverified = c.unverified.some((u) => !u.out_of_scope);
      if (!anyNonPassAc && !anyInScopeUnverified) {
        return 'non-pass final_verdict with no non-pass AC and no in-scope unverified entry';
      }
    }
    return null;
  };
}

/* ------------------------- structural factors (for the table) ------------------------- */

export interface RebuildFactors {
  verdict: 'allow' | 'block';
  testExitCode: number;
  pending_count: number;
  overclaim_count: number;
  reasons_count: number;
  repeat_block: boolean;
}

export function rebuildFactors(pair: FixturePair, d: StopGateDecision): RebuildFactors {
  return {
    verdict: d.exitCode === 0 ? 'allow' : 'block',
    testExitCode: pair.rebuild.testExitCode,
    pending_count: pendingCount(pair.rebuild.state),
    overclaim_count: acsClaimingPassWithoutEvidence(pair.rebuild.state).length,
    reasons_count: d.reasons.length,
    repeat_block: d.repeatBlock,
  };
}

export interface SrcFactors {
  verdict: 'allow' | 'block';
  final_verdict: CompletionContract['final_verdict'];
  per_ac: Array<{ criterion_id: string; verdict: string }>;
  in_scope_unverified_count: number;
  non_terminal_node_count: number;
  barrier_state: 'green' | 'failed' | 'absent' | 'other';
  non_pass_state: string | null;
}

export function srcFactors(pair: FixturePair, c: CompletionContract): SrcFactors {
  const barrier = pair.src.graph.nodes.find((n) => n.kind === 'test');
  const barrierState = !barrier
    ? 'absent'
    : barrier.status === 'failed'
      ? 'failed'
      : barrier.status === 'passed' && barrier.evidence_refs.some((e) => e.kind === 'command')
        ? 'green'
        : 'other';
  return {
    verdict: c.final_verdict === 'pass' ? 'allow' : 'block',
    final_verdict: c.final_verdict,
    per_ac: c.acceptance.map((a) => ({ criterion_id: a.criterion_id, verdict: a.verdict })),
    in_scope_unverified_count: c.unverified.filter((u) => !u.out_of_scope).length,
    non_terminal_node_count: pair.src.graph.nodes.filter(
      (n) => n.status !== 'passed' && n.status !== 'failed',
    ).length,
    barrier_state: barrierState,
    non_pass_state: c.non_pass_status?.state ?? null,
  };
}

/**
 * Mechanical divergence-cause derivation from STRUCTURAL fields only (never from
 * reasons-string matching): list the block factors each side fired on and diff.
 */
export function divergenceCause(r: RebuildFactors, s: SrcFactors): string | null {
  if (r.verdict === s.verdict) return null;
  const rebuildFired: string[] = [];
  if (r.testExitCode !== 0) rebuildFired.push('tests-red');
  if (r.pending_count > 0) rebuildFired.push('pending-items');
  if (r.overclaim_count > 0) rebuildFired.push('pass-without-evidence(trim)');
  const srcFired: string[] = [];
  if (s.per_ac.some((a) => a.verdict !== 'pass')) srcFired.push('non-pass-ac');
  if (s.in_scope_unverified_count > 0) srcFired.push('in-scope-unverified-floor');
  if (s.non_terminal_node_count > 0) srcFired.push('non-terminal-nodes');
  return `rebuild[${r.verdict}: ${rebuildFired.join(',') || 'none'}] vs src[${s.verdict}: ${srcFired.join(',') || 'none'}]`;
}
