import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextNode } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { type ActiveHandoff, HandoffStore } from '~/core/handoff-store';
import { defaultIntentQualityDeps } from '~/core/intent-quality-doctor';
import { WorkItemStore } from '~/core/work-item-store';
import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';
import { type Handoff, handoff } from '~/schemas/handoff';

// ─────────────────────────────────────────────────────────────────────────────
// WHY THESE TESTS EXIST (wi_260714xpw, node impl-schema-scope-union)
//
// The handoff's anchor is turning from a single required top-level `work_item_id`
// into a discriminated union `scope` (work_item | session). Two ACs pin this:
//
//   ac-3: `scope` is a discriminated union; a SESSION-scoped file parses with ITS
//         OWN required-field set (session_id) and is INCLUDED in the list — it is
//         NOT fail-open dropped just because it lacks a work_item_id.
//   ac-5: back-compat — an OLD on-disk handoff (top-level `work_item_id`, NO
//         `scope` discriminator) keeps parsing. A z.discriminatedUnion needs the
//         discriminant present, so an absent `scope` must be normalized to
//         {kind:'work_item', work_item_id} BEFORE the union parse.
//
// Because the union removes the top-level `work_item_id`, the two out-of-store
// consumers that filtered on it (intent-quality-doctor.countHandoffRounds and the
// autopilot-loop context-pressure proxy in computePostCost) must switch to
// matching `scope.kind==='work_item' && scope.work_item_id===id` — and a SESSION
// handoff must NOT be counted against a work_item id. Those consumer filters are
// covered here by spying HandoffStore.listActive (mock-isolated from the
// sibling-owned handoff-store disk format).
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-07-14T00:00:00.000Z');

// Every required handoff field EXCEPT the anchor (scope / legacy work_item_id).
const baseFields = {
  schema_version: '0.1.0' as const,
  from_context: 'claude-code session at 60% context after implement node',
  original_intent: 'do the thing',
  current_state: 'midway',
  next_first_check: 'run bun test and inspect the range clamp',
  created_at: NOW.toISOString(),
};

describe('handoff scope discriminated union (ac-3)', () => {
  test('a session-scoped file parses with its OWN required set (session_id) and is not dropped', () => {
    const sessionFile = {
      ...baseFields,
      scope: { kind: 'session', session_id: 'sess-abc123' },
    };
    // Its required set is session_id — NO work_item_id required for this variant.
    expect(() => handoff.parse(sessionFile)).not.toThrow();
    const parsed = handoff.parse(sessionFile);
    expect(parsed.scope.kind).toBe('session');
    if (parsed.scope.kind === 'session') {
      expect(parsed.scope.session_id).toBe('sess-abc123');
    }
  });

  test('a session scope missing its own required session_id is rejected', () => {
    const sessionMissingId = { ...baseFields, scope: { kind: 'session' } };
    expect(() => handoff.parse(sessionMissingId)).toThrow();
  });

  test('a new-format work_item scope parses and keeps the work_item_id under scope', () => {
    const wiFile = {
      ...baseFields,
      scope: { kind: 'work_item', work_item_id: 'wi_new00001' },
    };
    expect(() => handoff.parse(wiFile)).not.toThrow();
    const parsed = handoff.parse(wiFile);
    expect(parsed.scope.kind).toBe('work_item');
    if (parsed.scope.kind === 'work_item') {
      expect(parsed.scope.work_item_id).toBe('wi_new00001');
    }
  });

  test('an unknown scope kind is rejected (union stays minimal: work_item|session only)', () => {
    const bogus = { ...baseFields, scope: { kind: 'organization', org_id: 'org_x' } };
    expect(() => handoff.parse(bogus)).toThrow();
  });
});

describe('handoff back-compat: legacy WI-key files still parse (ac-5)', () => {
  test('an OLD file with top-level work_item_id and NO scope normalizes to a work_item scope', () => {
    const oldWiFile = { ...baseFields, work_item_id: 'wi_legacy01' };
    // The discriminator is absent on disk — it must be supplied before the union
    // parse, not rejected.
    expect(() => handoff.parse(oldWiFile)).not.toThrow();
    const parsed = handoff.parse(oldWiFile);
    expect(parsed.scope).toBeDefined();
    expect(parsed.scope.kind).toBe('work_item');
    if (parsed.scope.kind === 'work_item') {
      expect(parsed.scope.work_item_id).toBe('wi_legacy01');
    }
  });

  test('a legacy file still missing a genuinely-required field (next_first_check) still fails', () => {
    const { next_first_check, ...withoutCheck } = baseFields;
    const bad = { ...withoutCheck, work_item_id: 'wi_legacy02' };
    expect(() => handoff.parse(bad)).toThrow();
  });
});

// ── consumer filters: session handoff is NOT counted against a work_item id ──────

function active(scope: Record<string, unknown>): ActiveHandoff {
  return {
    handoff: { ...baseFields, scope } as unknown as Handoff,
    body: '',
    path: `.ditto/local/handoff/${String(scope.work_item_id ?? scope.session_id)}.md`,
  };
}

describe('consumer: intent-quality-doctor countHandoffRounds (ac-3/ac-5)', () => {
  test('counts only the work_item scope matching the id; a session handoff is excluded', async () => {
    const spy = spyOn(HandoffStore.prototype, 'listActive').mockResolvedValue([
      active({ kind: 'work_item', work_item_id: 'wi_target01' }),
      active({ kind: 'work_item', work_item_id: 'wi_other001' }),
      active({ kind: 'session', session_id: 'sess-1' }),
    ]);
    try {
      const deps = defaultIntentQualityDeps('/nonexistent-repo-for-doctor');
      const count = await deps.countHandoffRounds('wi_target01');
      // 1 = only the wi_target01 work_item handoff. The other work_item (different
      // id) and the session-scoped handoff are BOTH excluded.
      expect(count).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// The autopilot-loop consumer lives in the private computePostCost, reached via the
// exported nextNode → readContextPressure. post_cost = drift + rework + retry/switch
// + handoffRounds; in a fresh temp repo with only neutral escalate decisions and
// zero fix-attempts, post_cost == handoffRounds, so it isolates the handoff filter.

let repo: string;
let aps: AutopilotStore;
let WI: string;

function node(id: string, over: Partial<AutopilotNode> = {}): AutopilotNode {
  return {
    id,
    kind: 'research',
    owner: 'researcher',
    purpose: `work ${id}`,
    status: 'pending',
    depends_on: [],
    acceptance_refs: [],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
    ...over,
  } as AutopilotNode;
}

function graph(nodes: AutopilotNode[]): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_scope001',
    work_item_id: WI,
    mode: 'autopilot',
    root_goal: 'goal',
    completion_boundary: 'entire_work_item',
    approval_gate: {
      status: 'not_required',
      source: 'small_reversible_policy',
      approved_at: null,
      approved_by: null,
      evidence_refs: [],
    },
    nodes,
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

describe('consumer: autopilot-loop computePostCost handoff filter (ac-3/ac-5)', () => {
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-scope-'));
    aps = new AutopilotStore(repo);
    const wi = await new WorkItemStore(repo).create(
      {
        title: 'scope test',
        source_request: 'test scope union filter',
        goal: 'the filter counts only matching work_item scope',
        acceptance_criteria: [
          { id: 'ac-1', statement: 'runs', verdict: 'unverified', evidence: [] },
        ],
      },
      NOW,
    );
    WI = wi.id;
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test('post_cost counts only the work_item scope matching the WI; session excluded', async () => {
    // 3 nodes + 30 neutral escalate decisions ⇒ proxy over threshold so the
    // context-pressure signal (which carries post_cost) is attached.
    await aps.write(
      WI,
      graph([node('N1'), node('N2', { depends_on: ['N1'] }), node('N3', { depends_on: ['N2'] })]),
    );
    for (let i = 0; i < 30; i++) {
      await aps.appendDecision(WI, {
        ts: NOW.toISOString(),
        node_id: 'N1',
        failure_class: 'user_decision_needed',
        decision: 'escalate',
        reason: `escalation ${i}`,
        attempts: { fix: 0, switch: 0 },
      });
    }
    const spy = spyOn(HandoffStore.prototype, 'listActive').mockResolvedValue([
      active({ kind: 'work_item', work_item_id: WI }),
      active({ kind: 'work_item', work_item_id: 'wi_other001' }),
      active({ kind: 'session', session_id: 'sess-2' }),
    ]);
    try {
      const res = await nextNode(repo, WI);
      if (res.action !== 'spawn') throw new Error('expected spawn');
      // drift 0 + rework 0 + retry/switch 0 + handoffRounds ⇒ post_cost == handoffRounds.
      // Only the WI-matching work_item handoff counts (session + other-id excluded).
      expect(res.context_pressure?.post_cost).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
