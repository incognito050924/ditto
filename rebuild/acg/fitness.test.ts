import { describe, expect, test } from 'bun:test';

import type { AnalysisFinding, AnalysisRequest, AnalysisResult } from '../analysis';
import { FakeStaticAnalysisHost } from '../analysis';
import {
  type FitnessContext,
  type FitnessFunction,
  assessDelta,
  evaluateConformance,
  fitnessFunction,
  normalizeViolationIdentity,
  runFitness,
  scheduleDecision,
} from './fitness';

const REQ: AnalysisRequest = { files: ['rebuild/acg/fitness.ts'] };

function fn(overrides: Partial<FitnessFunction> = {}): FitnessFunction {
  return fitnessFunction.parse({
    id: 'ff-1',
    statement: 'core must not import util directly',
    evaluator: { mode: 'deterministic' },
    cadence: { per_change: true, periodic: 'none' },
    on_violation: 'block',
    ...overrides,
  });
}

function finding(overrides: Partial<AnalysisFinding> = {}): AnalysisFinding {
  return {
    rule: 'acg/forbidden-dep',
    severity: 'error',
    path: 'rebuild/core/x.ts',
    line: 10,
    message: 'core imports util',
    ...overrides,
  };
}

// ─── ADR-0004 Q4: cost-policy scheduling ────────────────────────────────────

describe('scheduleDecision — ADR-0004 Q4 cost policy', () => {
  test('deterministic per_change runs on a per_change trigger', () => {
    const ctx: FitnessContext = { trigger: 'per_change', riskKnown: true };
    expect(scheduleDecision(fn(), ctx).run).toBe(true);
  });

  test('cadence.per_change=false does not run on a per_change trigger', () => {
    const ctx: FitnessContext = { trigger: 'per_change', riskKnown: true };
    expect(scheduleDecision(fn({ cadence: { per_change: false, periodic: 'none' } }), ctx).run).toBe(
      false,
    );
  });

  test('executed + risk_tiered runs only for high risk (never per-change transitive sweep)', () => {
    const f = fn({ evaluator: { mode: 'executed', selection: 'risk_tiered' } });
    expect(scheduleDecision(f, { trigger: 'per_change', risk: 'low', riskKnown: true }).run).toBe(
      false,
    );
    expect(scheduleDecision(f, { trigger: 'per_change', risk: 'high', riskKnown: true }).run).toBe(
      true,
    );
  });

  test('SAFETY INVARIANT: unknown risk ESCALATES to run, never samples down (fail-closed)', () => {
    const f = fn({ evaluator: { mode: 'executed', selection: 'sampled' } });
    const decision = scheduleDecision(f, { trigger: 'per_change', riskKnown: false });
    expect(decision.run).toBe(true);
    expect(decision.reason).toContain('escalate');
  });

  test('periodic function runs on a matching periodic trigger, skips per_change', () => {
    const f = fn({ cadence: { per_change: false, periodic: 'on_release' } });
    expect(scheduleDecision(f, { trigger: 'periodic', period: 'on_release', riskKnown: true }).run).toBe(
      true,
    );
    expect(scheduleDecision(f, { trigger: 'per_change', riskKnown: true }).run).toBe(false);
  });
});

// ─── ADR-0004 Q4: violation identity + delta ────────────────────────────────

describe('normalizeViolationIdentity — stable key excludes raw line (ADR-0004 Q4)', () => {
  test('same rule/path/site with different lines is the SAME identity (line move ≠ new violation)', () => {
    const a = normalizeViolationIdentity({ rule: 'r', path: 'p', enclosing: 'f', line: 10 });
    const b = normalizeViolationIdentity({ rule: 'r', path: 'p', enclosing: 'f', line: 99 });
    expect(a).toBe(b);
  });

  test('different rule or site yields a different identity', () => {
    const base = normalizeViolationIdentity({ rule: 'r', path: 'p', enclosing: 'f' });
    expect(normalizeViolationIdentity({ rule: 'r2', path: 'p', enclosing: 'f' })).not.toBe(base);
    expect(normalizeViolationIdentity({ rule: 'r', path: 'p', enclosing: 'g' })).not.toBe(base);
  });
});

describe('assessDelta — delta_only blocks only NEW violations (ADR-0004 Q4)', () => {
  test('without delta_only, all current violations block', () => {
    const f = fn({ on_violation: 'block' });
    const d = assessDelta(f, ['r@p#a', 'r@p#b']);
    expect(d.blocked).toBe(true);
    expect(d.new_violation_ids.length).toBe(2);
  });

  test('with delta_only, a baseline violation is legacy debt and does NOT block', () => {
    const f = fn({ baseline: { snapshot: 'r@p#a', delta_only: true } });
    const d = assessDelta(f, ['r@p#a']);
    expect(d.new_violation_ids).toEqual([]);
    expect(d.blocked).toBe(false);
  });

  test('with delta_only, a violation not in baseline is new and blocks', () => {
    const f = fn({ baseline: { snapshot: 'r@p#a', delta_only: true }, on_violation: 'block' });
    const d = assessDelta(f, ['r@p#a', 'r@p#b']);
    expect(d.new_violation_ids).toEqual(['r@p#b']);
    expect(d.blocked).toBe(true);
  });

  test('on_violation=warn never blocks even with new violations', () => {
    const f = fn({ on_violation: 'warn' });
    expect(assessDelta(f, ['r@p#a']).blocked).toBe(false);
  });
});

// ─── ADR-0006 + honest-unverified: conformance via the analysis seam ─────────

describe('evaluateConformance — CodeQL via the rebuild/analysis seam (ADR-0006)', () => {
  test('a CLEAN codeql scan (ok + zero findings) is a conformance PASS', () => {
    const result: AnalysisResult = { status: 'ok', analyzer: 'codeql', findings: [] };
    expect(evaluateConformance(fn(), result).verdict).toBe('pass');
  });

  test('codeql findings on a block function are a conformance FAIL', () => {
    const result: AnalysisResult = {
      status: 'ok',
      analyzer: 'codeql',
      findings: [finding()],
    };
    const out = evaluateConformance(fn({ on_violation: 'block' }), result);
    expect(out.verdict).toBe('fail');
    expect(out.violation_ids.length).toBe(1);
  });

  test('HONEST-UNVERIFIED: a degraded (tool absent) analysis is UNVERIFIED, never a pass', () => {
    const degraded: AnalysisResult = {
      status: 'degraded',
      analyzer: 'codeql',
      reason: 'tool_absent',
      detail: 'codeql not installed',
    };
    const out = evaluateConformance(fn(), degraded);
    expect(out.verdict).toBe('unverified');
    // the critical rule: unverified must NOT collapse to pass.
    expect(out.verdict).not.toBe('pass');
  });

  test('HONEST-UNVERIFIED: a tool_error degraded analysis is also UNVERIFIED, never pass/fail-clean', () => {
    const degraded: AnalysisResult = {
      status: 'degraded',
      analyzer: 'codeql',
      reason: 'tool_error',
      detail: 'codeql crashed',
    };
    expect(evaluateConformance(fn(), degraded).verdict).toBe('unverified');
  });
});

// ─── runFitness: schedule → seam → aggregate verdict ─────────────────────────

describe('runFitness — schedule + CodeQL seam + aggregate conformance verdict', () => {
  const ctx: FitnessContext = { trigger: 'per_change', riskKnown: true };

  test('a not-scheduled function is SKIP (not evaluated, not a false pass)', async () => {
    const host = new FakeStaticAnalysisHost({ present: { codeql: { findings: [] } } });
    const f = fn({ cadence: { per_change: false, periodic: 'none' } });
    const run = await runFitness([f], ctx, () => REQ, host);
    expect(run.results[0]?.outcome).toBe('skip');
    expect(run.verdict).toBe('pass'); // nothing ran → nothing unverified/failed
  });

  test('a clean codeql scan yields outcome pass and aggregate pass', async () => {
    const host = new FakeStaticAnalysisHost({ present: { codeql: { findings: [] } } });
    const run = await runFitness([fn()], ctx, () => REQ, host);
    expect(run.results[0]?.outcome).toBe('pass');
    expect(run.verdict).toBe('pass');
  });

  test('codeql findings yield outcome fail and aggregate fail', async () => {
    const host = new FakeStaticAnalysisHost({
      present: { codeql: { findings: [finding()] } },
    });
    const run = await runFitness([fn({ on_violation: 'block' })], ctx, () => REQ, host);
    expect(run.results[0]?.outcome).toBe('fail');
    expect(run.verdict).toBe('fail');
  });

  test('HONEST-UNVERIFIED end-to-end: codeql ABSENT → outcome unverified, aggregate unverified (NOT pass)', async () => {
    const host = new FakeStaticAnalysisHost({}); // codeql not scripted → probe absent
    const run = await runFitness([fn()], ctx, () => REQ, host);
    expect(run.results[0]?.outcome).toBe('unverified');
    expect(run.verdict).toBe('unverified');
    expect(run.verdict).not.toBe('pass');
  });

  test('worst-wins: fail dominates unverified dominates pass', async () => {
    // one clean, one absent (unverified), one with findings (fail) → aggregate fail.
    const host = new FakeStaticAnalysisHost({
      present: { codeql: { findings: [finding()] } },
    });
    const run = await runFitness([fn({ on_violation: 'block' })], ctx, () => REQ, host);
    expect(run.verdict).toBe('fail');
  });
});
