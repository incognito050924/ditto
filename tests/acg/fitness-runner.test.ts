import { describe, expect, test } from 'bun:test';
import {
  type EvaluatorProvider,
  type FitnessContext,
  assessDelta,
  normalizeViolationIdentity,
  runFitness,
  scheduleDecision,
} from '~/acg/fitness/fitness-runner';
import { acgAssuranceSnapshot } from '~/schemas/acg-assurance-snapshot';
import { type AcgFitnessFunction, acgFitnessFunction } from '~/schemas/acg-fitness-function';

const fn = (overrides: Record<string, unknown> = {}): AcgFitnessFunction =>
  acgFitnessFunction.parse({
    schema_version: '0.1.0',
    kind: 'acg.fitness-function.v1',
    produced_by: 'agent',
    produced_at: '2026-06-04T00:00:00Z',
    id: 'ff-test',
    statement: 'keep it tidy',
    fitness_kind: 'architectural',
    evaluator: { mode: 'deterministic', spec: 'echo' },
    cadence: { per_change: true, periodic: 'none' },
    on_violation: 'block',
    ...overrides,
  });

const ctx = (o: Partial<FitnessContext> = {}): FitnessContext => ({
  trigger: 'per_change',
  riskKnown: true,
  producedAt: '2026-06-04T00:00:00Z',
  ...o,
});

describe('scheduleDecision (ADR-0004 cost policy)', () => {
  test('deterministic per_change → run', () => {
    expect(scheduleDecision(fn(), ctx()).run).toBe(true);
  });
  test('cadence.per_change=false → skip', () => {
    expect(
      scheduleDecision(fn({ cadence: { per_change: false, periodic: 'none' } }), ctx()).run,
    ).toBe(false);
  });
  test('executed risk_tiered + risk low (known) → defer', () => {
    const f = fn({
      evaluator: { mode: 'executed', spec: 'e2e', execution: { selection: 'risk_tiered' } },
    });
    expect(scheduleDecision(f, ctx({ risk: 'low', riskKnown: true })).run).toBe(false);
  });
  test('SAFETY: executed risk_tiered + risk UNKNOWN → escalate (run, fail-closed)', () => {
    const f = fn({
      evaluator: { mode: 'executed', spec: 'e2e', execution: { selection: 'risk_tiered' } },
    });
    const d = scheduleDecision(f, ctx({ riskKnown: false }));
    expect(d.run).toBe(true);
    expect(d.reason).toContain('escalate');
  });
  test('executed risk_tiered + risk high → run', () => {
    const f = fn({
      evaluator: { mode: 'executed', spec: 'e2e', execution: { selection: 'risk_tiered' } },
    });
    expect(scheduleDecision(f, ctx({ risk: 'high', riskKnown: true })).run).toBe(true);
  });
  test('executed selection=per_change → run (explicit)', () => {
    const f = fn({
      evaluator: { mode: 'executed', spec: 'e2e', execution: { selection: 'per_change' } },
    });
    expect(scheduleDecision(f, ctx()).run).toBe(true);
  });
  test('periodic trigger matches cadence.periodic=on_release', () => {
    const f = fn({ cadence: { per_change: false, periodic: 'on_release' } });
    expect(scheduleDecision(f, ctx({ trigger: 'periodic', period: 'on_release' })).run).toBe(true);
    expect(scheduleDecision(f, ctx({ trigger: 'periodic', period: 'daily' })).run).toBe(false);
  });
});

describe('normalizeViolationIdentity (line move is not a new violation)', () => {
  test('same rule+path+enclosing at different lines → identical identity', () => {
    const a = normalizeViolationIdentity({
      rule: 'no-any',
      path: 'src/x.ts',
      enclosing: 'foo',
      line: 10,
    });
    const b = normalizeViolationIdentity({
      rule: 'no-any',
      path: 'src/x.ts',
      enclosing: 'foo',
      line: 99,
    });
    expect(a).toBe(b);
  });
  test('different enclosing → different identity', () => {
    const a = normalizeViolationIdentity({ rule: 'no-any', path: 'src/x.ts', enclosing: 'foo' });
    const b = normalizeViolationIdentity({ rule: 'no-any', path: 'src/x.ts', enclosing: 'bar' });
    expect(a).not.toBe(b);
  });
});

describe('assessDelta (delta_only enforces only new violations)', () => {
  test('delta_only: only violations absent from baseline block', () => {
    const f = fn({ baseline: { snapshot: 'A\nB', delta_only: true } });
    const d = assessDelta(f, ['A', 'B', 'C']);
    expect(d.new_violation_ids).toEqual(['C']);
    expect(d.outcome).toBe('fail');
  });
  test('delta_only with only legacy debt → pass (new empty)', () => {
    const f = fn({ baseline: { snapshot: 'A\nB', delta_only: true } });
    const d = assessDelta(f, ['A', 'B']);
    expect(d.new_violation_ids).toEqual([]);
    expect(d.outcome).toBe('pass');
  });
  test('no delta_only: all current violations block', () => {
    const f = fn({ baseline: { snapshot: 'A', delta_only: false } });
    expect(assessDelta(f, ['A', 'B']).outcome).toBe('fail');
  });
  test('on_violation=track never fails even with new violations', () => {
    const f = fn({ on_violation: 'track', baseline: { snapshot: '', delta_only: true } });
    expect(assessDelta(f, ['A']).outcome).toBe('pass');
  });
});

describe('runFitness → AssuranceSnapshot', () => {
  const provider = (map: Record<string, string[]>): EvaluatorProvider => ({
    evaluate: async (f) => ({ violationIds: map[f.id] ?? [] }),
  });

  test('produces a schema-valid snapshot; new violation → fail, skipped → skip', async () => {
    const blocking = fn({ id: 'ff-a', baseline: { snapshot: 'A', delta_only: true } });
    const deferred = fn({
      id: 'ff-b',
      evaluator: { mode: 'executed', spec: 'e2e', execution: { selection: 'risk_tiered' } },
    });
    const snap = await runFitness(
      [blocking, deferred],
      ctx({ risk: 'low', riskKnown: true }),
      provider({ 'ff-a': ['A', 'B'] }),
    );
    expect(acgAssuranceSnapshot.safeParse(snap).success).toBe(true);
    const a = snap.results.find((r) => r.function_id === 'ff-a');
    const b = snap.results.find((r) => r.function_id === 'ff-b');
    expect(a?.outcome).toBe('fail');
    expect(a?.new_violation_ids).toEqual(['B']);
    expect(b?.outcome).toBe('skip'); // risk low + risk_tiered → deferred
    expect(snap.trigger).toBe('per_change');
  });
});
