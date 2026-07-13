import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authoredTestPaths,
  hasAuthoredTestSpec,
  rejectForReauthor,
} from '~/core/autopilot-approval';
import { bootstrapAutopilot } from '~/core/autopilot-bootstrap';
import { kindToOwner } from '~/core/autopilot-graph';
import { nextNode, recordResult } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import type { CaptureResult } from '~/core/test-runner';
import { WorkItemStore } from '~/core/work-item-store';
import type { Autopilot } from '~/schemas/autopilot';
import { intentContract } from '~/schemas/intent';

/**
 * WHY THIS FILE EXISTS (wi_2607105qy N2 — pre-approval red-test AUTHORING STAGE):
 *
 * A new `test-author` node authors a failing (red) unit test for each `dynamic_test`
 * AC BEFORE the approval gate opens, and populates `approval_gate.plan_brief.test_spec`.
 * These are mock/unit-tier assertions (bootstrap seeding is pure over the intent; the
 * loop carve-out + populate run against a tmp AutopilotStore, no LLM).
 */

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-author-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const safeRisk = { non_local: false, irreversible: false, unaudited: false };

/** A work item + intent whose ac-1 carries a `dynamic_test` oracle (⇒ authoring node). */
async function setupWithDynamicTest(withDynamic = true) {
  const oracle = withDynamic
    ? {
        verification_method: 'dynamic_test' as const,
        maps_to: 'ac-1',
        direction: 'forward' as const,
      }
    : {
        verification_method: 'soft_judgment' as const,
        maps_to: 'ac-1',
        direction: 'forward' as const,
      };
  const wi = await new WorkItemStore(repo).create({
    title: 'pw',
    source_request: 'add endpoint',
    goal: 'POST /pw returns a score',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'POST /pw returns 200', verdict: 'unverified', evidence: [] },
    ],
  });
  const intent = intentContract.parse({
    schema_version: '0.1.0',
    work_item_id: wi.id,
    source_request: 'add endpoint',
    goal: 'POST /pw returns a score',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'POST /pw returns 200', evidence_required: ['test'], oracle },
    ],
    question_policy: 'ask_only_if_user_only_can_answer',
  });
  return { wi, intent };
}

describe('test-author kind + owner (piece 1)', () => {
  test('the test-author kind maps to a spawnable mutating owner (implementer)', () => {
    expect(kindToOwner('test-author')).toBe('implementer');
  });
});

describe('seeding the authoring node (piece 2)', () => {
  test('≥1 dynamic_test AC ⇒ test-author node BETWEEN design and implement, implement depends_on it', async () => {
    const { wi, intent } = await setupWithDynamicTest(true);
    const result = await bootstrapAutopilot(repo, { workItem: wi, intent, risk: safeRisk });
    if (result.status !== 'created') throw new Error(`expected created, got ${result.status}`);
    // design → test-author → implement → verify → test(barrier)
    expect(result.graph.nodes.map((n) => n.kind)).toEqual([
      'design',
      'test-author',
      'implement',
      'verify',
      'test',
    ]);
    const design = result.graph.nodes.find((n) => n.kind === 'design');
    const author = result.graph.nodes.find((n) => n.kind === 'test-author');
    const implement = result.graph.nodes.find((n) => n.kind === 'implement');
    expect(author?.owner).toBe('implementer');
    expect(author?.depends_on).toEqual([(design as NonNullable<typeof design>).id]);
    expect(implement?.depends_on).toEqual([(author as NonNullable<typeof author>).id]);
    // A barrier still anchors on the implement node (unaffected by the new kind).
    expect(result.graph.nodes.find((n) => n.kind === 'test')?.depends_on).toEqual([
      (implement as NonNullable<typeof implement>).id,
    ]);
  });

  test('no dynamic_test AC ⇒ NO authoring node (ac-5 degrade precondition)', async () => {
    const { wi, intent } = await setupWithDynamicTest(false);
    const result = await bootstrapAutopilot(repo, { workItem: wi, intent, risk: safeRisk });
    if (result.status !== 'created') throw new Error('expected created');
    expect(result.graph.nodes.some((n) => n.kind === 'test-author')).toBe(false);
    expect(result.graph.nodes.map((n) => n.kind)).toEqual([
      'design',
      'implement',
      'verify',
      'test',
    ]);
  });

  test('with e2eOptIn: order is design → e2e-author → test-author → implement', async () => {
    const { wi, intent } = await setupWithDynamicTest(true);
    const result = await bootstrapAutopilot(repo, {
      workItem: wi,
      intent,
      risk: safeRisk,
      e2eOptIn: true,
    });
    if (result.status !== 'created') throw new Error('expected created');
    expect(result.graph.nodes.map((n) => n.kind)).toEqual([
      'design',
      'e2e-author',
      'test-author',
      'implement',
      'verify',
      'test',
    ]);
    const e2e = result.graph.nodes.find((n) => n.kind === 'e2e-author');
    const author = result.graph.nodes.find((n) => n.kind === 'test-author');
    const implement = result.graph.nodes.find((n) => n.kind === 'implement');
    expect(author?.depends_on).toEqual([(e2e as NonNullable<typeof e2e>).id]);
    expect(implement?.depends_on).toEqual([(author as NonNullable<typeof author>).id]);
  });
});

describe('presence-marker gate (piece 4): keys off test_spec presence, not change_surface', () => {
  const base = {
    status: 'pending' as const,
    source: null,
    approved_at: null,
    approved_by: null,
    evidence_refs: [] as never[],
  };
  test('gate carrying an authored test_spec ⇒ marker true', () => {
    expect(
      hasAuthoredTestSpec({
        ...base,
        plan_brief: {
          interface_changes: [],
          dod: [],
          test_scenarios: [],
          test_spec: {
            test_backed: [{ criterion_id: 'ac-1', test_path: 'tests/a.test.ts' }],
            oracle_only: [],
          },
        },
      }),
    ).toBe(true);
  });
  test('legacy gate (no plan_brief / no test_spec) ⇒ marker false', () => {
    expect(hasAuthoredTestSpec(base)).toBe(false);
  });
  test('a brief-regime gate with change_surface but NO test_spec is NOT retro-gated (marker false)', () => {
    expect(
      hasAuthoredTestSpec({
        ...base,
        change_surface: ['src/x.ts'],
        plan_brief: { interface_changes: [], dod: [], test_scenarios: [] },
      }),
    ).toBe(false);
  });
});

// ── loop-level pieces (carve-out + populate) run against a tmp store ──────────
let aps: AutopilotStore;
let wis: WorkItemStore;
let WI: string;
const NOW = new Date('2026-07-11T00:00:00.000Z');

async function loopSetup() {
  aps = new AutopilotStore(repo);
  wis = new WorkItemStore(repo);
  const wi = await wis.create(
    {
      title: 'author loop',
      source_request: 'author red tests',
      goal: 'authoring stage runs',
      acceptance_criteria: [{ id: 'ac-1', statement: 'runs', verdict: 'unverified', evidence: [] }],
    },
    NOW,
  );
  WI = wi.id;
  await wis.update(WI, (w) => ({ ...w, changed_files: ['tests/authored-ac1.test.ts'] }));
}

/** A minimal graph: passed design → pending test-author → implement, approval PENDING. */
function authorGraph(): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_authortest',
    work_item_id: WI,
    mode: 'autopilot',
    root_goal: 'goal',
    completion_boundary: 'entire_work_item',
    approval_gate: {
      status: 'pending',
      source: null,
      approved_at: null,
      approved_by: null,
      evidence_refs: [],
      change_surface: ['src/x.ts'],
      plan_brief: { interface_changes: ['x'], dod: ['y'], test_scenarios: ['z'] },
    },
    nodes: [
      {
        id: 'N1',
        kind: 'design',
        owner: 'planner',
        purpose: 'plan',
        status: 'passed',
        depends_on: [],
        acceptance_refs: ['ac-1'],
        evidence_refs: [],
        ac_verdicts: [],
        attempts: { fix: 0, switch: 0 },
      },
      {
        id: 'N1-test-author',
        kind: 'test-author',
        owner: 'implementer',
        purpose: 'author red tests',
        status: 'pending',
        depends_on: ['N1'],
        acceptance_refs: [],
        evidence_refs: [],
        ac_verdicts: [],
        attempts: { fix: 0, switch: 0 },
        file_scope: ['tests/authored-ac1.test.ts'],
      },
      {
        id: 'N2',
        kind: 'implement',
        owner: 'implementer',
        purpose: 'implement',
        status: 'pending',
        depends_on: ['N1-test-author'],
        acceptance_refs: ['ac-1'],
        evidence_refs: [],
        ac_verdicts: [],
        attempts: { fix: 0, switch: 0 },
      },
    ],
    caps: {
      fix_per_node: 2,
      switch_per_node: 1,
      converge_rounds: 3,
      oracle_failures_to_block: 3,
      loop_rounds: 12,
      no_progress_rounds: 3,
      progress_continuation_cap: 24,
    },
    continue_policy: {
      continue_after_approval: true,
      continue_after_checkpoint: true,
      continue_after_fixable_failure: true,
      ask_user_only_for_user_owned_decisions: true,
    },
    stop_conditions: [],
    user_interrupt_policy: 'ask_only_for_user_owned_decisions',
  };
}

describe('authoring-only carve-out (piece 5): test-author runs pre-approval', () => {
  test('a pending-approval test-author node is DISPATCHED (spawn), not held on present_plan', async () => {
    await loopSetup();
    await aps.write(WI, authorGraph());
    const res = await nextNode(repo, WI);
    // The implement node (also implementer/mutating) would be present_plan under a
    // pending gate; the test-author node is exempt and dispatches.
    expect(res.action).toBe('spawn');
    if (res.action !== 'spawn') throw new Error('expected spawn');
    expect(res.node_id).toBe('N1-test-author');
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'N1-test-author')?.status).toBe('running');
  });

  test('a pending-approval IMPLEMENT node is still held (carve-out is kind-scoped, no blanket hole)', async () => {
    await loopSetup();
    // author already passed so the implement node is the ready mutating node.
    const g = authorGraph();
    g.nodes = g.nodes.map((n) => (n.id === 'N1-test-author' ? { ...n, status: 'passed' } : n));
    await aps.write(WI, g);
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('present_plan');
  });
});

// A deterministic capture runner the phantom-red gate (ac-3 Part A) is injected with,
// so the loop-wiring stays a mock/unit test (no real subprocess / no nested `bun test`).
const ASSERTION_RED: CaptureResult = {
  outcome: { kind: 'failed', exitCode: 1 },
  captured: '(fail) ac-1 > x\n error: expect(received).toBe(expected)\n 0 pass\n 1 fail',
};
const COMPILE_RED: CaptureResult = {
  outcome: { kind: 'failed', exitCode: 1 },
  captured: "error: Cannot find module './handler'\n 0 pass\n 0 fail",
};
const injectRed =
  (r: CaptureResult) =>
  async (_p: string): Promise<CaptureResult> =>
    r;

describe('populate test_spec (piece 3): authoring result writes plan_brief.test_spec', () => {
  test('a contentful test-author pass merges test_spec.test_backed into the approval gate', async () => {
    await loopSetup();
    await aps.write(WI, authorGraph());
    await nextNode(repo, WI); // dispatch N1-test-author → running
    const res = await recordResult(repo, {
      workItemId: WI,
      authoredRedRunOne: injectRed(ASSERTION_RED),
      payload: {
        node_id: 'N1-test-author',
        result_text:
          'Authored the failing red unit test tests/authored-ac1.test.ts for ac-1; confirmed it fails on the AC assertion.',
        outcome: 'pass',
        changed_files: ['tests/authored-ac1.test.ts'],
        test_spec: {
          test_backed: [{ criterion_id: 'ac-1', test_path: 'tests/authored-ac1.test.ts' }],
          oracle_only: ['ac-2'],
        },
      },
      now: NOW,
    });
    expect(res.outcome).toBe('pass');
    const after = await aps.get(WI);
    const spec = after.approval_gate.plan_brief?.test_spec;
    expect(spec?.test_backed[0]?.criterion_id).toBe('ac-1');
    expect(spec?.test_backed[0]?.test_path).toBe('tests/authored-ac1.test.ts');
    expect(spec?.oracle_only).toEqual(['ac-2']);
    // the pre-existing brief body is preserved (merge, not overwrite).
    expect(after.approval_gate.plan_brief?.interface_changes).toEqual(['x']);
  });
});

describe('phantom-red HARD gate (ac-3 Part A): the authored red tests are RUN pre-approval', () => {
  test('a compile/import (phantom) red BLOCKS the pass — node does not pass, test_spec NOT merged', async () => {
    await loopSetup();
    await aps.write(WI, authorGraph());
    await nextNode(repo, WI); // dispatch N1-test-author → running
    const res = await recordResult(repo, {
      workItemId: WI,
      authoredRedRunOne: injectRed(COMPILE_RED),
      payload: {
        node_id: 'N1-test-author',
        result_text: 'Authored tests/authored-ac1.test.ts for ac-1; it fails (claimed red).',
        outcome: 'pass',
        changed_files: ['tests/authored-ac1.test.ts'],
        test_spec: {
          test_backed: [{ criterion_id: 'ac-1', test_path: 'tests/authored-ac1.test.ts' }],
          oracle_only: [],
        },
      },
      now: NOW,
    });
    // Phantom red ⇒ the claimed pass is downgraded to a fixable failure (re-author).
    expect(res.outcome).toBe('fail');
    expect(res.failure_class).toBe('fixable');
    const after = await aps.get(WI);
    // The author node did NOT pass (stays pending for a re-author), so implement — which
    // depends_on it — never becomes ready and the gate never presents a phantom plan.
    expect(after.nodes.find((n) => n.id === 'N1-test-author')?.status).not.toBe('passed');
    // The phantom test_spec was NOT merged into the approval gate.
    expect(after.approval_gate.plan_brief?.test_spec).toBeUndefined();
  });

  test('an assertion-red pass FREEZES a content-hash manifest (frozen_hash) into the gate', async () => {
    await loopSetup();
    // The authored test must exist on disk so its content hash can be captured at freeze.
    await Bun.write(
      join(repo, 'tests/authored-ac1.test.ts'),
      'test("red", () => expect(1).toBe(2));',
    );
    await aps.write(WI, authorGraph());
    await nextNode(repo, WI);
    const res = await recordResult(repo, {
      workItemId: WI,
      authoredRedRunOne: injectRed(ASSERTION_RED),
      payload: {
        node_id: 'N1-test-author',
        result_text: 'Authored tests/authored-ac1.test.ts for ac-1; confirmed assertion-red.',
        outcome: 'pass',
        changed_files: ['tests/authored-ac1.test.ts'],
        test_spec: {
          test_backed: [{ criterion_id: 'ac-1', test_path: 'tests/authored-ac1.test.ts' }],
          oracle_only: [],
        },
      },
      now: NOW,
    });
    expect(res.outcome).toBe('pass');
    const after = await aps.get(WI);
    const frozen = after.approval_gate.plan_brief?.test_spec?.test_backed[0]?.frozen_hash;
    expect(typeof frozen).toBe('string');
    expect((frozen ?? '').length).toBeGreaterThan(0);
  });
});

// ── ac-3 Part B: the implement node cannot weaken/delete a frozen test ──────────
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A graph past freeze: gate APPROVED carrying a frozen manifest; implement node pending. */
function frozenImplementGraph(frozenHash: string): Autopilot {
  const g = authorGraph();
  return {
    ...g,
    approval_gate: {
      ...g.approval_gate,
      status: 'approved',
      source: 'user',
      approved_at: NOW.toISOString(),
      approved_by: 'user',
      plan_brief: {
        interface_changes: ['x'],
        dod: ['y'],
        test_scenarios: ['z'],
        test_spec: {
          test_backed: [
            {
              criterion_id: 'ac-1',
              test_path: 'tests/frozen-ac1.test.ts',
              frozen_hash: frozenHash,
            },
          ],
          oracle_only: [],
        },
      },
    },
    // design + test-author already passed; implement is the ready mutating node.
    nodes: g.nodes.map((n) => (n.kind === 'test-author' ? { ...n, status: 'passed' as const } : n)),
  };
}

describe('frozen-test integrity guard (ac-3 Part B): implement cannot weaken/delete a frozen test', () => {
  test('a WEAKENED frozen test (content changed) downgrades the implement pass to a fixable failure', async () => {
    await loopSetup();
    const original = 'test("red", () => expect(1).toBe(2));';
    await Bun.write(join(repo, 'tests/frozen-ac1.test.ts'), original);
    await aps.write(WI, frozenImplementGraph(sha256(original)));
    // The implement node edits (weakens) the frozen test — a different content hash.
    await Bun.write(
      join(repo, 'tests/frozen-ac1.test.ts'),
      'test("red", () => expect(1).toBe(1)); // gutted',
    );
    await nextNode(repo, WI); // approved gate ⇒ dispatch implement (N2) → running
    const res = await recordResult(repo, {
      workItemId: WI,
      payload: {
        node_id: 'N2',
        result_text: 'Implemented the feature and made the test green.',
        outcome: 'pass',
        changed_files: ['src/x.ts', 'tests/frozen-ac1.test.ts'],
      },
      now: NOW,
    });
    expect(res.outcome).toBe('fail');
    expect(res.failure_class).toBe('fixable');
    expect(res.reason.toLowerCase()).toContain('frozen');
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'N2')?.status).not.toBe('passed');
  });

  test('an INTACT frozen test (unchanged content) lets the implement pass proceed', async () => {
    await loopSetup();
    const original = 'test("red", () => expect(1).toBe(2));';
    await Bun.write(join(repo, 'tests/frozen-ac1.test.ts'), original);
    await aps.write(WI, frozenImplementGraph(sha256(original)));
    await nextNode(repo, WI);
    const res = await recordResult(repo, {
      workItemId: WI,
      payload: {
        node_id: 'N2',
        result_text: 'Implemented the feature; the frozen test is now green, untouched.',
        outcome: 'pass',
        changed_files: ['src/x.ts'],
      },
      now: NOW,
    });
    expect(res.outcome).toBe('pass');
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'N2')?.status).toBe('passed');
  });
});

// ── ac-3 Part C: rejection cleanup lifecycle ───────────────────────────────────
describe('authoredTestPaths (pure): the authored red-test files carried on the gate', () => {
  const base = {
    status: 'pending' as const,
    source: null,
    approved_at: null,
    approved_by: null,
    evidence_refs: [] as never[],
  };
  test('extracts every test_backed path from the gate test_spec', () => {
    expect(
      authoredTestPaths({
        ...base,
        plan_brief: {
          interface_changes: [],
          dod: [],
          test_scenarios: [],
          test_spec: {
            test_backed: [
              { criterion_id: 'ac-1', test_path: 'tests/a.test.ts' },
              { criterion_id: 'ac-2', test_path: 'tests/b.test.ts' },
            ],
            oracle_only: [],
          },
        },
      }),
    ).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
  });
  test('a gate with no test_spec ⇒ [] (nothing authored)', () => {
    expect(authoredTestPaths(base)).toEqual([]);
  });
});

describe('rejectForReauthor (ac-3 Part C): post-freeze drift escape (approved ⇒ rejected)', () => {
  const approved = {
    status: 'approved' as const,
    source: 'user' as const,
    approved_at: '2026-07-11T00:00:00.000Z',
    approved_by: 'user',
    evidence_refs: [] as never[],
    plan_brief: {
      interface_changes: [],
      dod: [],
      test_scenarios: [],
      test_spec: {
        test_backed: [{ criterion_id: 'ac-1', test_path: 'tests/a.test.ts' }],
        oracle_only: [],
      },
    },
  };
  test('an APPROVED gate can be transitioned to rejected for re-authoring (not only an out-of-band unblock)', () => {
    const next = rejectForReauthor(approved, 'frozen test drifted from the code');
    expect(next.status).toBe('rejected');
    // The reason is recorded so the re-author is auditable.
    expect(next.evidence_refs.some((e) => e.summary?.includes('drifted'))).toBe(true);
  });
  test('rejectForReauthor is only valid post-freeze (from approved); a pending gate throws', () => {
    expect(() => rejectForReauthor({ ...approved, status: 'pending' })).toThrow();
  });
});

/** A REJECTED gate carrying a frozen manifest + a passed test-author node. */
function rejectedGraphWithAuthoredFiles(): Autopilot {
  const g = authorGraph();
  return {
    ...g,
    approval_gate: {
      ...g.approval_gate,
      status: 'rejected',
      plan_brief: {
        interface_changes: ['x'],
        dod: ['y'],
        test_scenarios: ['z'],
        test_spec: {
          test_backed: [{ criterion_id: 'ac-1', test_path: 'tests/authored-ac1.test.ts' }],
          oracle_only: [],
        },
      },
    },
    nodes: g.nodes.map((n) => (n.kind === 'test-author' ? { ...n, status: 'passed' as const } : n)),
  };
}

describe('rejection cleans up authored files + prevents a passed-author stale cascade', () => {
  test('nextNode on a rejected gate DELETES the authored test files (no orphans)', async () => {
    await loopSetup();
    await Bun.write(
      join(repo, 'tests/authored-ac1.test.ts'),
      'test("red", () => expect(1).toBe(2));',
    );
    expect(await Bun.file(join(repo, 'tests/authored-ac1.test.ts')).exists()).toBe(true);
    await aps.write(WI, rejectedGraphWithAuthoredFiles());
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('rollback');
    // The orphan authored test file is gone.
    expect(await Bun.file(join(repo, 'tests/authored-ac1.test.ts')).exists()).toBe(false);
  });

  test('rejection clears the stale test_spec and resets the passed test-author node (stale cascade)', async () => {
    await loopSetup();
    await Bun.write(join(repo, 'tests/authored-ac1.test.ts'), 'x');
    await aps.write(WI, rejectedGraphWithAuthoredFiles());
    await nextNode(repo, WI);
    const after = await aps.get(WI);
    // The now-invalid authored manifest is cleared so a re-plan re-authors fresh.
    expect(after.approval_gate.plan_brief?.test_spec).toBeUndefined();
    // The passed authoring node is reset so it re-runs (no passed-author stale cascade).
    expect(after.nodes.find((n) => n.kind === 'test-author')?.status).not.toBe('passed');
  });
});
