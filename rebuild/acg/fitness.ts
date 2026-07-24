import { z } from 'zod';

import {
  type AnalysisFinding,
  type AnalysisRequest,
  type AnalysisResult,
  type AnalyzerKind,
  type StaticAnalysisHost,
  analysisDisposition,
  runAnalysis,
} from '../analysis';

/**
 * ACG FitnessFunction runner — the rebuild re-expression of the ADR-0004 Q4 cost
 * policy and the ADR-0006 CodeQL-single engine, made executable on rebuild's own
 * primitives (NOT a copy of src/). Three deterministic concerns:
 *
 *  1. SCHEDULING (scheduleDecision): which functions run for this trigger, per
 *     mode (ADR-0004 Q4). The SAFETY INVARIANT is fail-closed — when the change's
 *     risk is unknown, executed selection ESCALATES to run, never samples down.
 *  2. IDENTITY + DELTA (normalizeViolationIdentity / assessDelta): a stable key
 *     excluding the raw line (a line move is not a false new violation), and
 *     delta_only so only genuinely-new violations block; legacy debt is tracked.
 *  3. CONFORMANCE (evaluateConformance / runFitness): the actual scan runs
 *     through the rebuild/analysis A17 seam with CodeQL as the engine (ADR-0006).
 *     A DEGRADED (absent/failed) analysis is honestly UNVERIFIED — it NEVER
 *     collapses into a conformance pass (ADR-0018 honest-unverified).
 */

// ─── FitnessFunction representation ─────────────────────────────────────────

export const fitnessEvaluatorMode = z.enum(['deterministic', 'llm_judged', 'executed']);
export type FitnessEvaluatorMode = z.infer<typeof fitnessEvaluatorMode>;

export const fitnessSelection = z.enum(['per_change', 'risk_tiered', 'sampled', 'periodic']);
export type FitnessSelection = z.infer<typeof fitnessSelection>;

export const fitnessPeriodic = z.enum(['none', 'daily', 'weekly', 'on_release']);
export type FitnessPeriodic = z.infer<typeof fitnessPeriodic>;

export const fitnessFunction = z
  .object({
    id: z.string().min(1),
    statement: z.string().min(1),
    evaluator: z
      .object({
        mode: fitnessEvaluatorMode,
        // executed cost tiering (ADR-0004 Q4); absent ⇒ per_change.
        selection: fitnessSelection.optional(),
      })
      .strict(),
    cadence: z
      .object({
        per_change: z.boolean().default(false),
        periodic: fitnessPeriodic.default('none'),
      })
      .strict(),
    baseline: z
      .object({
        // delimited identity set captured at introduction — existing debt.
        snapshot: z.string().optional(),
        delta_only: z.boolean().optional(),
      })
      .strict()
      .optional(),
    on_violation: z.enum(['block', 'warn', 'track']),
  })
  .strict();
export type FitnessFunction = z.infer<typeof fitnessFunction>;

export interface FitnessContext {
  trigger: 'per_change' | 'periodic';
  /** for trigger=periodic. */
  period?: FitnessPeriodic;
  /** risk tier of the change (executed risk_tiered scheduling). */
  risk?: 'low' | 'medium' | 'high';
  /** false when no ImpactGraph/boundary input — forces fail-closed escalation. */
  riskKnown: boolean;
}

// ─── 1. SCHEDULING (ADR-0004 Q4 cost policy) ────────────────────────────────

export interface ScheduleDecision {
  run: boolean;
  reason: string;
}

/** Should this function run for this trigger/context? (ADR-0004 Q4 cost policy.) */
export function scheduleDecision(fn: FitnessFunction, ctx: FitnessContext): ScheduleDecision {
  if (ctx.trigger === 'periodic') {
    const p = fn.cadence.periodic;
    if (p !== 'none' && (!ctx.period || p === ctx.period)) {
      return { run: true, reason: `periodic=${p}` };
    }
    return { run: false, reason: `periodic=${p} does not match ${ctx.period ?? 'any'}` };
  }
  // per_change trigger
  if (!fn.cadence.per_change) return { run: false, reason: 'cadence.per_change=false' };

  if (fn.evaluator.mode === 'executed') {
    const sel = fn.evaluator.selection ?? 'per_change';
    if (sel === 'periodic') return { run: false, reason: 'executed selection=periodic (deferred)' };
    if (sel === 'per_change') {
      return { run: true, reason: 'executed selection=per_change (explicit)' };
    }
    // risk_tiered / sampled: fail-closed — unknown risk ESCALATES to run.
    if (!ctx.riskKnown) {
      return {
        run: true,
        reason: `executed selection=${sel} but risk unknown → escalate (fail-closed)`,
      };
    }
    if (ctx.risk === 'high') return { run: true, reason: `executed selection=${sel}, risk=high` };
    return { run: false, reason: `executed selection=${sel}, risk=${ctx.risk ?? 'low'} → defer` };
  }
  // deterministic / llm_judged per_change.
  return { run: true, reason: `${fn.evaluator.mode} per_change` };
}

// ─── 2. IDENTITY + DELTA (ADR-0004 Q4) ──────────────────────────────────────

export interface RawViolation {
  rule: string;
  path?: string;
  enclosing?: string;
  line?: number;
}

/**
 * Stable violation identity (ADR-0004 Q4 recipe). Deliberately excludes the raw
 * line so a code move is not counted as a new violation; path + enclosing symbol
 * pin the site. Identity = `rule@path#site`.
 */
export function normalizeViolationIdentity(v: RawViolation): string {
  const site = v.enclosing ?? '<top>';
  const path = v.path ?? '<nopath>';
  return `${v.rule}@${path}#${site}`;
}

/** Project one analysis finding onto a violation identity (raw line dropped). */
export function findingToViolationId(f: AnalysisFinding): string {
  return normalizeViolationIdentity({ rule: f.rule, path: f.path });
}

/** Parse baseline.snapshot (a delimited identity set) into a Set. */
function parseBaselineSet(snapshot: string | undefined): Set<string> {
  if (!snapshot) return new Set();
  return new Set(
    snapshot
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export interface DeltaResult {
  violation_ids: string[];
  new_violation_ids: string[];
  /** true iff on_violation=block AND the blocking set is non-empty. */
  blocked: boolean;
}

/**
 * Compute the delta for one function's current violation set. delta_only ⇒ only
 * violations absent from the baseline block (legacy debt is tracked, not hidden);
 * otherwise every current violation is blocking. Only on_violation=block turns a
 * non-empty blocking set into an actual block.
 */
export function assessDelta(fn: FitnessFunction, currentIds: string[]): DeltaResult {
  const current = [...new Set(currentIds)];
  const baseline = parseBaselineSet(fn.baseline?.snapshot);
  const newIds = current.filter((id) => !baseline.has(id));
  const deltaOnly = fn.baseline?.delta_only === true;
  const blockingIds = deltaOnly ? newIds : current;
  const blocked = fn.on_violation === 'block' && blockingIds.length > 0;
  return { violation_ids: current, new_violation_ids: newIds, blocked };
}

// ─── 3. CONFORMANCE via the analysis seam (ADR-0006 + honest-unverified) ─────

/** The engine ACG extracts static facts with (ADR-0006 CodeQL-single). */
const CONFORMANCE_ANALYZER: AnalyzerKind = 'codeql';

export type ConformanceVerdict = 'pass' | 'fail' | 'unverified';

export interface ConformanceResult {
  verdict: ConformanceVerdict;
  violation_ids: string[];
  new_violation_ids: string[];
  grounds: string;
}

/**
 * Fold one AnalysisResult (from the rebuild/analysis A17 seam) into a conformance
 * verdict. The honest-unverified rule lives here and is total over the seam's
 * disposition, so a `degraded` analysis can NEVER become a pass:
 *
 *   analysisDisposition(result):
 *     'unverified' → verdict 'unverified'  (tool absent/failed — NOT a clean bill)
 *     'clean'      → verdict 'pass'         (a real scan found nothing)
 *     'findings'   → delta/on_violation decide 'fail' vs 'pass'
 */
export function evaluateConformance(
  fn: FitnessFunction,
  result: AnalysisResult,
): ConformanceResult {
  const disposition = analysisDisposition(result);
  if (disposition === 'unverified') {
    const detail = result.status === 'degraded' ? result.detail : 'analysis unverified';
    return {
      verdict: 'unverified',
      violation_ids: [],
      new_violation_ids: [],
      grounds: `codeql analysis unverified (${detail}) — conformance is honestly unverified, not a pass`,
    };
  }
  const currentIds =
    result.status === 'ok' ? [...new Set(result.findings.map(findingToViolationId))] : [];
  const delta = assessDelta(fn, currentIds);
  if (delta.blocked) {
    return {
      verdict: 'fail',
      violation_ids: delta.violation_ids,
      new_violation_ids: delta.new_violation_ids,
      grounds: `${fn.id}: ${delta.new_violation_ids.length} new violation(s) block (on_violation=block)`,
    };
  }
  return {
    verdict: 'pass',
    violation_ids: delta.violation_ids,
    new_violation_ids: delta.new_violation_ids,
    grounds:
      disposition === 'clean'
        ? `${fn.id}: codeql scan clean`
        : `${fn.id}: violations present but not blocking (on_violation=${fn.on_violation}${fn.baseline?.delta_only ? ', delta_only' : ''})`,
  };
}

// ─── runFitness: schedule → seam → aggregate verdict ────────────────────────

export type FitnessOutcome = 'skip' | ConformanceVerdict;

export interface FitnessResultEntry {
  function_id: string;
  outcome: FitnessOutcome;
  reason: string;
  violation_ids?: string[];
  new_violation_ids?: string[];
}

export interface FitnessRunResult {
  /** Aggregate, worst-wins: fail > unverified > pass (skips do not count). */
  verdict: ConformanceVerdict;
  results: FitnessResultEntry[];
}

/** Resolve the analysis request (change scope) for one fitness function. */
export type FitnessRequestResolver = (fn: FitnessFunction) => AnalysisRequest;

/**
 * Run a set of fitness functions for one trigger. Scheduling + delta are
 * deterministic; the scan itself goes through the injected A17 host via
 * runAnalysis (ADR-0006 CodeQL engine). The aggregate verdict is worst-wins with
 * unverified strictly between pass and fail — so an absent tool pulls the whole
 * governance gate to honestly unverified rather than a false green.
 */
export async function runFitness(
  functions: FitnessFunction[],
  ctx: FitnessContext,
  resolveRequest: FitnessRequestResolver,
  host: StaticAnalysisHost,
): Promise<FitnessRunResult> {
  const results: FitnessResultEntry[] = [];
  for (const fn of functions) {
    const decision = scheduleDecision(fn, ctx);
    if (!decision.run) {
      results.push({ function_id: fn.id, outcome: 'skip', reason: decision.reason });
      continue;
    }
    const analysis = await runAnalysis(CONFORMANCE_ANALYZER, resolveRequest(fn), host);
    const conformance = evaluateConformance(fn, analysis);
    results.push({
      function_id: fn.id,
      outcome: conformance.verdict,
      reason: conformance.grounds,
      violation_ids: conformance.violation_ids,
      new_violation_ids: conformance.new_violation_ids,
    });
  }
  return { verdict: aggregateVerdict(results), results };
}

/** Worst-wins over the scheduled outcomes: fail > unverified > pass. */
function aggregateVerdict(results: FitnessResultEntry[]): ConformanceVerdict {
  let verdict: ConformanceVerdict = 'pass';
  for (const r of results) {
    if (r.outcome === 'fail') return 'fail';
    if (r.outcome === 'unverified') verdict = 'unverified';
  }
  return verdict;
}
