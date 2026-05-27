import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acceptanceTestable,
  completionGate,
  convergenceGate,
  deterministicFloor,
  highRiskAssumption,
  interviewReadinessGate,
  safeDefaultable,
} from '~/core/gates';
import { completionContract } from '~/schemas/completion-contract';
import { convergence } from '~/schemas/convergence';
import { intentContract } from '~/schemas/intent';
import { interviewState } from '~/schemas/interview-state';
import { workItem } from '~/schemas/work-item';

const ROOT = join(import.meta.dir, '..', 'fixtures', 'gates');
const load = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

describe('deterministicFloor', () => {
  test('is the weighted sum of open sections, conflicts, and assumption ratio', () => {
    expect(
      deterministicFloor({ open_required_sections: 0, conflicting: 0, assumption_ratio: 0 }),
    ).toBe(0);
    expect(
      deterministicFloor({ open_required_sections: 2, conflicting: 1, assumption_ratio: 1 }),
    ).toBeCloseTo(0.05 * 2 + 0.1 + 0.05, 5);
  });

  test('clamps to [0,1]', () => {
    expect(
      deterministicFloor({ open_required_sections: 100, conflicting: 100, assumption_ratio: 1 }),
    ).toBe(1);
  });
});

describe('interviewReadinessGate', () => {
  test('ready fixture passes', () => {
    const state = interviewState.parse(load('interview-state/ready.json'));
    expect(interviewReadinessGate(state).pass).toBe(true);
  });

  test('blocked fixture fails (critical unresolved)', () => {
    const state = interviewState.parse(load('interview-state/blocked.json'));
    const result = interviewReadinessGate(state);
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes('critical'))).toBe(true);
  });
});

describe('acceptanceTestable', () => {
  test('observable criteria pass', () => {
    const intent = intentContract.parse(load('intent/observable-ac.json'));
    for (const ac of intent.acceptance_criteria) {
      expect(acceptanceTestable({ statement: ac.statement }).pass).toBe(true);
    }
  });

  test('vague criteria fail', () => {
    const intent = intentContract.parse(load('intent/vague-ac.json'));
    for (const ac of intent.acceptance_criteria) {
      expect(acceptanceTestable({ statement: ac.statement }).pass).toBe(false);
    }
  });
});

describe('completionGate cross-checks against the work item', () => {
  const item = workItem.parse(load('completion-crosscheck/workitem.json'));
  const completionOf = (rel: string) =>
    completionContract.parse(load(`completion-crosscheck/${rel}`));

  test('exact AC-set match passes', () => {
    expect(completionGate(item, completionOf('completion-match.json')).pass).toBe(true);
  });

  test('missing criterion fails', () => {
    const r = completionGate(item, completionOf('completion-missing.json'));
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('missing'))).toBe(true);
  });

  test('extra criterion fails', () => {
    const r = completionGate(item, completionOf('completion-extra.json'));
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('extra'))).toBe(true);
  });

  test('duplicate criterion fails (count-based, not Set-based)', () => {
    const r = completionGate(item, completionOf('completion-duplicate.json'));
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('duplicate'))).toBe(true);
  });
});

describe('convergenceGate reads recorded fields only', () => {
  test('converged fixture passes', () => {
    const c = convergence.parse(load('convergence/converged.json'));
    expect(convergenceGate(c).pass).toBe(true);
  });

  test('treadmill fixture fails (open admissible remains)', () => {
    const c = convergence.parse(load('convergence/treadmill.json'));
    const r = convergenceGate(c);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('not converged'))).toBe(true);
  });

  test('early-converge fixture fails (declares converged with open admissible)', () => {
    const c = convergence.parse(load('convergence/early-converge.json'));
    const r = convergenceGate(c);
    expect(r.pass).toBe(false);
    // open_admissible_count recorded 0 but ledger has an open admissible objection,
    // and selected_version is not argmax.
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});

describe('highRiskAssumption / safeDefaultable are two sides of one predicate', () => {
  test('high-risk fixture is high risk and not safe-defaultable', () => {
    const a = load('assumption/high-risk.json') as {
      non_local: boolean;
      irreversible: boolean;
      unaudited: boolean;
    };
    expect(highRiskAssumption(a)).toBe(true);
    expect(safeDefaultable(a)).toBe(false);
  });

  test('safe fixture is not high risk and is safe-defaultable', () => {
    const a = load('assumption/safe.json') as {
      non_local: boolean;
      irreversible: boolean;
      unaudited: boolean;
    };
    expect(highRiskAssumption(a)).toBe(false);
    expect(safeDefaultable(a)).toBe(true);
  });
});
