import { describe, expect, test } from 'bun:test';
import { applyApproval } from '~/core/autopilot-approval';
import { recordResultPayload } from '~/core/autopilot-loop';
import { producePlanGate } from '~/core/coverage-manager';
import { autopilot } from '~/schemas/autopilot';

/**
 * WHY THIS FILE EXISTS (wi_2607105qy N2 — "executable Definition-of-Done"):
 *
 * The plan promotes the approval gate into a DoD where each `dynamic_test` AC has an
 * authored red test referenced from the approval brief, and where test-backed ACs are
 * distinguished from oracle-only ACs. That reference + distinction must be carried on
 * `approval_gate.plan_brief` as a NEW `test_spec` field.
 *
 * DoD ac-1 clause ("3개 스키마 payload/PlanGate/persisted 전부 선언 — silent-strip 방지"):
 * the SAME field must be declared in THREE schemas that the brief flows through, or a
 * value set upstream is silently STRIPPED by zod (unknown keys are dropped by default)
 * before it reaches the persisted gate — a false-green where the approval artifact loses
 * its test references. The three schemas:
 *   1. persisted           — `autopilot` (src/schemas/autopilot.ts approval_gate.plan_brief)
 *   2. record-result payload — `recordResultPayload` (src/core/autopilot-loop.ts) plan_brief
 *   3. PlanGate patch       — `producePlanGate` output (src/core/coverage-manager.ts)
 *
 * DoD ac-2 clause ("old-shape approval_gate parse fixture 테스트 추가"): the field must be
 * backward-compatible — an in-flight autopilot.json written BEFORE this change (no
 * `test_spec`) must still parse AND the approval transition (`applyApproval`) must behave
 * identically (completion currency unchanged, no regression).
 *
 * These are SCHEMA/pure-function assertions (no filesystem, no LLM) — a mock/unit tier
 * test, scope-local to the schema + coverage-manager + payload declarations.
 */

/** A `test_spec` value as the pre-approval authoring stage would produce it. */
const TEST_SPEC = {
  // ac-1: per dynamic_test AC, a reference to the authored (red) unit test file.
  test_backed: [{ criterion_id: 'ac-1', test_path: 'tests/core/authored-ac1.test.ts' }],
  // ac-4: the oracle-only (static_scan / soft_judgment) ACs, distinguished from the
  // test-backed set so the approval screen can render them separately.
  oracle_only: ['ac-2'],
  // ac-6: the predictable rendered-artifact path the gate message points the user at.
  artifact_path: '.ditto/local/work-items/wi_test0001/approval/index.md',
};

/** Minimal valid persisted graph carrying a plan_brief with the new test_spec. */
function graphWithTestSpec() {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_test0001',
    work_item_id: 'wi_test0001',
    root_goal: 'promote approval gate into an executable DoD',
    approval_gate: {
      status: 'pending',
      change_surface: ['src/schemas/autopilot.ts'],
      plan_brief: {
        interface_changes: ['add test_spec to plan_brief'],
        dod: ['test_spec preserved across three schemas'],
        test_scenarios: ['old-shape parses'],
        test_spec: TEST_SPEC,
      },
    },
    caps: { fix_per_node: 2, switch_per_node: 1 },
    continue_policy: {},
  };
}

describe('test_spec is declared (not silently stripped) across all three brief schemas (DoD ac-1)', () => {
  // Behavior verified: parsing a graph whose plan_brief carries `test_spec` PRESERVES it.
  // Edge case (the exact bug this guards): zod strips unknown keys by default, so BEFORE
  // the field is declared this parse SUCCEEDS but drops test_spec → the expectation on the
  // parsed value is what fails (an assertion-red on the AC clause, not a compile/import
  // error). This encodes ac-1 completely for the persisted tier: presence AND fidelity of
  // both the test_backed reference and the oracle_only distinction.
  test('persisted `autopilot` schema preserves plan_brief.test_spec round-trip', () => {
    const parsed = autopilot.parse(graphWithTestSpec());
    const spec = parsed.approval_gate.plan_brief?.test_spec;
    expect(spec).toBeDefined();
    expect(spec?.test_backed).toEqual([
      { criterion_id: 'ac-1', test_path: 'tests/core/authored-ac1.test.ts' },
    ]);
    expect(spec?.oracle_only).toEqual(['ac-2']);
    expect(spec?.artifact_path).toBe('.ditto/local/work-items/wi_test0001/approval/index.md');
  });

  // Behavior verified: the record-result payload a design/planner node returns can carry
  // test_spec on its plan_brief, so the loop does not lose it before writing the gate.
  // Edge case: this is the UPSTREAM producer of the persisted value; if the payload schema
  // drops it, the persisted schema never receives it — both must declare the field.
  test('record-result payload plan_brief preserves test_spec', () => {
    const parsed = recordResultPayload.parse({
      node_id: 'N1',
      result_text: 'design done',
      outcome: 'pass',
      plan_brief: {
        change_surface: ['src/schemas/autopilot.ts'],
        interface_changes: [],
        dod: [],
        test_scenarios: [],
        tier_inputs: {
          changedFileCount: 1,
          interfaceChanged: true,
          risk: { non_local: false, irreversible: false, unaudited: false },
          large: false,
        },
        test_spec: TEST_SPEC,
      },
    });
    expect(parsed.plan_brief?.test_spec).toEqual(TEST_SPEC);
  });

  // Behavior verified: producePlanGate (the deterministic PlanGate step between the
  // payload and the persisted write) passes test_spec THROUGH into the patch it returns.
  // Edge case: producePlanGate rebuilds plan_brief field-by-field (spread copies), so an
  // undeclared test_spec would be dropped even if both schemas around it declared it — the
  // middle transform is the third silent-strip site ac-1 names explicitly.
  test('producePlanGate carries brief.test_spec into the patch (no middle-transform strip)', () => {
    const patch = producePlanGate({
      changeSurface: ['src/schemas/autopilot.ts'],
      brief: {
        interface_changes: [],
        dod: [],
        test_scenarios: [],
        test_spec: TEST_SPEC,
      },
      tierInputs: {
        changedFileCount: 1,
        interfaceChanged: true,
        risk: { non_local: false, irreversible: false, unaudited: false },
        large: false,
      },
    });
    expect(patch.plan_brief.test_spec).toEqual(TEST_SPEC);
  });
});

describe('backward-compat: an old-shape gate (no test_spec) parses + approves unchanged (DoD ac-2)', () => {
  /** Old-shape graph: a plan_brief WITHOUT test_spec, as written before this change. */
  function oldShapeGraph() {
    const g = graphWithTestSpec();
    // Remove the new field to simulate an in-flight autopilot.json from before N2.
    const { test_spec: _omit, ...oldBrief } = g.approval_gate.plan_brief;
    return { ...g, approval_gate: { ...g.approval_gate, plan_brief: oldBrief } };
  }

  // Behavior verified: an in-flight graph missing test_spec still parses (the field is
  // optional/additive). Edge case: this is the regression floor — a required/new-shape-only
  // field would throw here and brick every in-flight run.
  test('old-shape autopilot.json parses without test_spec', () => {
    const parsed = autopilot.parse(oldShapeGraph());
    expect(parsed.approval_gate.plan_brief).toBeDefined();
    expect(parsed.approval_gate.plan_brief?.test_spec).toBeUndefined();
  });

  // Behavior verified: the completion currency (approval transition) is UNCHANGED for an
  // old-shape gate — applyApproval moves pending → approved exactly as before. Edge case:
  // confirms the new field did not leak into the approval transition path (no coupling).
  test('applyApproval behaves identically on an old-shape gate', () => {
    const parsed = autopilot.parse(oldShapeGraph());
    const now = new Date('2026-07-11T00:00:00.000Z');
    const next = applyApproval(parsed.approval_gate, { by: 'user', now });
    expect(next.status).toBe('approved');
    expect(next.approved_at).toBe('2026-07-11T00:00:00.000Z');
    expect(next.approved_by).toBe('user');
  });
});
