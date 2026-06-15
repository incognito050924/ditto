import type { AcgAssuranceSnapshot, AcgSnapshotResult } from '~/schemas/acg-assurance-snapshot';
import { acgAssuranceSnapshot } from '~/schemas/acg-assurance-snapshot';
import type { AcgFitnessFunction } from '~/schemas/acg-fitness-function';

/**
 * FitnessFunction runner — the cost policy of ADR-0004 made executable (단계8,
 * Q4). Three concerns, all deterministic and provider-injected:
 *
 *  1. SCHEDULING (selectForRun): which functions run for this trigger, per mode.
 *     executed + risk_tiered/sampled NEVER runs per-change blindly — but the
 *     SAFETY INVARIANT is fail-closed: when risk is unknown (no ImpactGraph) it
 *     ESCALATES to run, never samples down (ADR-0004 / OBJ-8/9).
 *  2. IDENTITY (normalizeViolationIdentity): a stable key (rule + enclosing
 *     symbol + normalized path, NO raw line) so a line move is not a false new
 *     violation (OBJ-11; codeql-research line-diff noise).
 *  3. DELTA (assessDelta): new_violation_ids = current set − baseline snapshot.
 *     delta_only ⇒ only new violations block; legacy debt is tracked, not hidden.
 *
 * The evaluator EXECUTION (CodeQL query / shell command / e2e) is the injected
 * provider; this module owns scheduling + delta + snapshot assembly.
 */

export interface RawViolation {
  rule: string;
  path?: string;
  symbol?: string;
  enclosing?: string;
  line?: number;
}

export interface FitnessContext {
  trigger: 'per_change' | 'periodic';
  /** for trigger=periodic. */
  period?: 'daily' | 'weekly' | 'on_release';
  changeRef?: string | null;
  /** risk tier of the change (executed risk_tiered scheduling). */
  risk?: 'low' | 'medium' | 'high';
  /** false when no ImpactGraph/boundary input — forces fail-closed escalation. */
  riskKnown: boolean;
  producedAt: string;
}

export interface EvaluatorProvider {
  /** Run the evaluator; return already-normalized violation identity strings. */
  evaluate(
    fn: AcgFitnessFunction,
    ctx: FitnessContext,
  ): Promise<{ skipped?: { reason: string }; violationIds: string[] }>;
}

/**
 * Stable violation identity (OBJ-11). Deliberately excludes the raw line number
 * so a code move is not counted as a new violation; path is dir+basename (no
 * line), symbol/enclosing pins the site.
 */
export function normalizeViolationIdentity(v: RawViolation): string {
  const site = v.enclosing ?? v.symbol ?? '<top>';
  const path = v.path ?? '<nopath>';
  return `${v.rule}@${path}#${site}`;
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

/** Rule prefix of an identity (`rule@path#site`); the move-invariant component. */
function ruleOf(id: string): string {
  const at = id.indexOf('@');
  return at < 0 ? id : id.slice(0, at);
}

/**
 * Relocation-aware new violations (PM-13/OBJ-01). A method move/extract changes
 * the enclosing/path, so the moved EXISTING violation gets a NEW identity — naive
 * set-difference (current − baseline) would mis-count it as new and block a legit
 * tidy. Fix: within each RULE (the only component invariant under a move), match
 * an "appeared" current id against a "disappeared" baseline id one-to-one; those
 * are relocations, not new. A current id is genuinely new only when its rule's
 * count actually grew. Preserves current order; the COUNT (what gates) is exact.
 */
function relocationAwareNewIds(current: string[], baseline: Set<string>): string[] {
  const currentSet = new Set(current);
  // Per-rule budget of baseline violations that disappeared (candidates for relocation).
  const disappearedBudget = new Map<string, number>();
  for (const id of baseline) {
    if (!currentSet.has(id)) {
      disappearedBudget.set(ruleOf(id), (disappearedBudget.get(ruleOf(id)) ?? 0) + 1);
    }
  }
  const newIds: string[] = [];
  for (const id of current) {
    if (baseline.has(id)) continue; // unchanged existing violation
    const rule = ruleOf(id);
    const budget = disappearedBudget.get(rule) ?? 0;
    if (budget > 0) {
      disappearedBudget.set(rule, budget - 1); // a relocation of a disappeared one
      continue;
    }
    newIds.push(id); // rule count grew → genuinely new
  }
  return newIds;
}

export interface ScheduleDecision {
  run: boolean;
  reason: string;
}

/** Should this function run for this trigger/context? (ADR-0004 cost policy.) */
export function scheduleDecision(fn: AcgFitnessFunction, ctx: FitnessContext): ScheduleDecision {
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
    const sel = fn.evaluator.execution?.selection ?? 'per_change';
    if (sel === 'periodic') return { run: false, reason: 'executed selection=periodic (deferred)' };
    if (sel === 'per_change')
      return { run: true, reason: 'executed selection=per_change (explicit)' };
    // risk_tiered / sampled: fail-closed — unknown risk escalates to run.
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

export interface DeltaResult {
  violation_ids: string[];
  new_violation_ids: string[];
  outcome: AcgSnapshotResult['outcome'];
}

/** Compute the delta + outcome for one function's current violation set. */
export function assessDelta(fn: AcgFitnessFunction, currentIds: string[]): DeltaResult {
  const current = [...new Set(currentIds)];
  const baseline = parseBaselineSet(fn.baseline?.snapshot);
  const newIds = relocationAwareNewIds(current, baseline);
  const deltaOnly = fn.baseline?.delta_only === true;
  const blockingIds = deltaOnly ? newIds : current;
  const outcome: AcgSnapshotResult['outcome'] =
    fn.on_violation === 'block' && blockingIds.length > 0 ? 'fail' : 'pass';
  return { violation_ids: current, new_violation_ids: newIds, outcome };
}

/**
 * Run a set of fitness functions for one trigger, producing an AssuranceSnapshot.
 * Scheduling + delta are deterministic here; the evaluator execution is the
 * injected provider. Validated against `acgAssuranceSnapshot` before return.
 */
export async function runFitness(
  functions: AcgFitnessFunction[],
  ctx: FitnessContext,
  provider: EvaluatorProvider,
): Promise<AcgAssuranceSnapshot> {
  const results: AcgSnapshotResult[] = [];
  for (const fn of functions) {
    const decision = scheduleDecision(fn, ctx);
    if (!decision.run) {
      results.push({ function_id: fn.id, outcome: 'skip' });
      continue;
    }
    const evald = await provider.evaluate(fn, ctx);
    if (evald.skipped) {
      results.push({ function_id: fn.id, outcome: 'skip' });
      continue;
    }
    const delta = assessDelta(fn, evald.violationIds);
    results.push({
      function_id: fn.id,
      outcome: delta.outcome,
      violations: delta.violation_ids.length,
      new_violations: delta.new_violation_ids.length,
      violation_ids: delta.violation_ids,
      new_violation_ids: delta.new_violation_ids,
    });
  }

  return acgAssuranceSnapshot.parse({
    schema_version: '0.1.0',
    kind: 'acg.assurance-snapshot.v1',
    produced_by: 'agent',
    produced_at: ctx.producedAt,
    at: ctx.producedAt,
    trigger: ctx.trigger,
    change_ref: ctx.changeRef ?? null,
    results,
  });
}
