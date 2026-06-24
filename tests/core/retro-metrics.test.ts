import { describe, expect, test } from 'bun:test';
import { buildDelegationPacket } from '~/core/autopilot-dispatch';
import {
  type RetroMetricInputs,
  assembleRetroMetrics,
  projectRetroNarrative,
} from '~/core/retro-measure';
import type { AutopilotNode } from '~/schemas/autopilot';
import type { WorkItem } from '~/schemas/work-item';

// ADR-0024 결정4 (ac-4): the retro carries TWO metrics, KEPT SEPARATE:
//   ① 산출물 floor: completion-coverage ratio + unit-only-closure aggregate +
//      escape-ledger recurrence.
//   ② 과정 건강도: intent-quality post_cost.
// Anti-SLOP: a slot is emitted ONLY when its grounding is present (re-evaluable);
// an ungrounded slot is OMITTED (its mere presence would induce bias). BUT a retro
// with ZERO grounded slots renders an EXPLICIT "no measurable signal" marker — not
// a silent omit-all (a silently-empty retro is indistinguishable from no retro).

function inputs(over: Partial<RetroMetricInputs> = {}): RetroMetricInputs {
  return { ...over };
}

describe('assembleRetroMetrics (ac-4: two SEPARATED metrics, anti-SLOP)', () => {
  test('the two metrics are NEVER merged into one number', () => {
    const m = assembleRetroMetrics(
      inputs({ coverage: 0.5, unit_only_closures: 1, escape_recurrence: 2, post_cost: 3 }),
    );
    // ① and ② live under distinct keys; no combined scalar exists.
    expect(m.outcome_floor).toBeDefined();
    expect(m.process_health).toBeDefined();
    expect(m).not.toHaveProperty('score');
    expect(m).not.toHaveProperty('combined');
    // process-health value is reachable only via its own group, not folded in.
    expect(m.process_health?.post_cost).toBe(3);
    expect(m.outcome_floor).not.toHaveProperty('post_cost');
  });

  test('① outcome_floor present when grounded; carries the three sub-signals', () => {
    const m = assembleRetroMetrics(
      inputs({ coverage: 0.75, unit_only_closures: 2, escape_recurrence: 1 }),
    );
    expect(m.outcome_floor).toEqual({
      coverage: 0.75,
      unit_only_closures: 2,
      escape_recurrence: 1,
    });
    // ② is absent because post_cost was not grounded → omit, not zero.
    expect(m.process_health).toBeUndefined();
    expect(m.no_measurable_signal).toBeUndefined();
  });

  test('a grounded slot is present, an ungrounded sub-slot is OMITTED (not zeroed)', () => {
    // coverage grounded; unit_only_closures + escape_recurrence ungrounded.
    const m = assembleRetroMetrics(inputs({ coverage: 0 }));
    expect(m.outcome_floor).toBeDefined();
    // coverage===0 is a grounded measurement (a real zero), so it IS present.
    expect(m.outcome_floor?.coverage).toBe(0);
    // the ungrounded sub-slots must NOT be emitted as placeholder zeros.
    expect(m.outcome_floor).not.toHaveProperty('unit_only_closures');
    expect(m.outcome_floor).not.toHaveProperty('escape_recurrence');
  });

  test('② process_health present alone when only post_cost is grounded', () => {
    const m = assembleRetroMetrics(inputs({ post_cost: 0 }));
    // post_cost===0 is a grounded measurement → present.
    expect(m.process_health).toEqual({ post_cost: 0 });
    expect(m.outcome_floor).toBeUndefined();
    expect(m.no_measurable_signal).toBeUndefined();
  });

  test('ZERO grounded slots → EXPLICIT no_measurable_signal marker (NOT a silent omit-all)', () => {
    const m = assembleRetroMetrics(inputs({}));
    expect(m.no_measurable_signal).toBe(true);
    // a silently-empty retro is indistinguishable from a missing retro: refuse it.
    expect(m.outcome_floor).toBeUndefined();
    expect(m.process_health).toBeUndefined();
  });

  test('null grounding (data read but absent) is treated as ungrounded → omit', () => {
    const m = assembleRetroMetrics(
      inputs({
        coverage: null,
        unit_only_closures: null,
        escape_recurrence: null,
        post_cost: null,
      }),
    );
    expect(m.no_measurable_signal).toBe(true);
    expect(m.outcome_floor).toBeUndefined();
    expect(m.process_health).toBeUndefined();
  });

  test('partial grounding: outcome_floor without escape_recurrence + process_health both present', () => {
    const m = assembleRetroMetrics(inputs({ coverage: 1, unit_only_closures: 0, post_cost: 4 }));
    expect(m.outcome_floor).toEqual({ coverage: 1, unit_only_closures: 0 });
    expect(m.outcome_floor).not.toHaveProperty('escape_recurrence');
    expect(m.process_health).toEqual({ post_cost: 4 });
    expect(m.no_measurable_signal).toBeUndefined();
  });
});

// Wiring (ADR-0024 결정4): the retro packet carries the assembled metrics +
// projection sources so the retrospective agent PRESENTS them. The builder stays
// pure: it injects whatever the loop hands it (or omits the field).
describe('buildDelegationPacket retro wiring', () => {
  const retroNode = {
    id: 'N7',
    kind: 'retro',
    owner: 'retrospective',
    purpose: 'Reflect on the completed run',
    status: 'pending',
    depends_on: [],
    acceptance_refs: [],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  } as unknown as AutopilotNode;
  const workItem = { id: 'wi_retrowi1', changed_files: [] } as unknown as WorkItem;

  test('context.retro is absent when no retroContext is passed (packet unchanged)', () => {
    const p = buildDelegationPacket(retroNode, workItem);
    expect(p.context.retro).toBeUndefined();
    expect('retro' in p.context).toBe(false);
  });

  test('a retro packet carries the assembled SEPARATED metrics + projected narrative', () => {
    const metrics = assembleRetroMetrics({ coverage: 0.8, post_cost: 2 });
    const narrative = projectRetroNarrative({
      work_item_id: 'wi_retrowi1',
      unverified: ['migration unrun'],
      residual_risks: [],
      close_reasons: [],
      intent_drift: [],
      evidence_refs: [],
    });
    const p = buildDelegationPacket(retroNode, workItem, [], [], undefined, { metrics, narrative });
    expect(p.context.retro?.metrics.outcome_floor?.coverage).toBe(0.8);
    expect(p.context.retro?.metrics.process_health?.post_cost).toBe(2);
    expect(JSON.stringify(p.context.retro?.narrative)).toContain('migration unrun');
  });
});
