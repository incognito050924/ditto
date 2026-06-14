import { describe, expect, test } from 'bun:test';
import {
  COVERAGE_AXES,
  COVERAGE_AXIS_MECHANISMS,
  COVERAGE_TIERS,
  addNode,
  buildJudgeInput,
  capStatus,
  closeNode,
  coverageClosureGate,
  isCoverageTerminated,
  recordDryRound,
  selectCoverageTier,
  selectReadyCoverageNodes,
  serializePlanDialog,
  tierBriefApproval,
  tierDepthBudget,
} from '~/core/coverage-manager';
import type { CoverageMap, CoverageNode } from '~/schemas/coverage';

// Builder helpers — keep the structural fields explicit so each test reads as a
// concrete tree shape (the Manager handles only these fields, never natural language).
const node = (over: Partial<CoverageNode> & Pick<CoverageNode, 'id'>): CoverageNode => ({
  parent_id: null,
  label: over.id,
  origin: 'seed',
  depth_weight: 1,
  state: 'open',
  children: [],
  ...over,
});

const emptyMap = (rootId = 'root'): CoverageMap => ({
  schema_version: '0.1.0',
  work_item_id: 'wi_test',
  root_id: rootId,
  nodes: [node({ id: rootId })],
});

describe('coverage Manager — tree CRUD (append-only growth)', () => {
  test('addNode appends a child and links it into the parent.children (no mutation of others)', () => {
    const map = emptyMap();
    const grown = addNode(map, node({ id: 'a', parent_id: 'root', origin: 'derived' }));
    expect(grown.nodes.map((n) => n.id).sort()).toEqual(['a', 'root']);
    const root = grown.nodes.find((n) => n.id === 'root');
    expect(root?.children).toEqual(['a']);
    // append-only: the original map object is not mutated.
    expect(map.nodes.find((n) => n.id === 'root')?.children).toEqual([]);
  });

  test('addNode rejects a duplicate id (append-only growth, no overwrite)', () => {
    const map = addNode(emptyMap(), node({ id: 'a', parent_id: 'root' }));
    expect(() => addNode(map, node({ id: 'a', parent_id: 'root' }))).toThrow(/duplicate/i);
  });

  test('addNode rejects a dangling parent_id', () => {
    expect(() => addNode(emptyMap(), node({ id: 'a', parent_id: 'ghost' }))).toThrow(/parent/i);
  });

  test('closeNode flips only the targeted node state; tree stays append-only (no removal)', () => {
    const map = addNode(emptyMap(), node({ id: 'a', parent_id: 'root' }));
    const closed = closeNode(map, 'a', 'resolved');
    expect(closed.nodes.find((n) => n.id === 'a')?.state).toBe('resolved');
    expect(closed.nodes.length).toBe(map.nodes.length); // append-only: count unchanged
  });
});

describe('coverage Manager — structural node scheduling (structure only)', () => {
  test('selects open leaves whose every child is closed; defers parents with open children', () => {
    // root → a (open, has open child a1) ; a1 open leaf. Only a1 is schedulable.
    let map = emptyMap();
    map = addNode(map, node({ id: 'a', parent_id: 'root' }));
    map = addNode(map, node({ id: 'a1', parent_id: 'a' }));
    expect(selectReadyCoverageNodes(map).map((n) => n.id)).toEqual(['a1']);
  });

  test('a parent becomes schedulable once its whole subtree is closed (false-green block)', () => {
    let map = emptyMap();
    map = addNode(map, node({ id: 'a', parent_id: 'root' }));
    map = addNode(map, node({ id: 'a1', parent_id: 'a' }));
    map = closeNode(map, 'a1', 'resolved');
    // now a (open) has all children closed → schedulable; root still has open child a.
    expect(selectReadyCoverageNodes(map).map((n) => n.id)).toEqual(['a']);
  });

  test('closed nodes are never re-selected', () => {
    let map = emptyMap();
    map = addNode(map, node({ id: 'a', parent_id: 'root' }));
    map = closeNode(map, 'a', 'out_of_scope');
    map = closeNode(map, 'root', 'resolved');
    expect(selectReadyCoverageNodes(map)).toEqual([]);
  });
});

describe('coverage Manager — false-green closure gate (§3.2 invariant)', () => {
  test('rejects a resolved projection onto a parent with an open child (subtree not dry)', () => {
    let map = emptyMap();
    map = addNode(map, node({ id: 'a', parent_id: 'root' }));
    map = addNode(map, node({ id: 'a1', parent_id: 'a' })); // a1 still open
    // projecting `resolved` onto a (whose child a1 is open) is the false-green case.
    const result = coverageClosureGate(map, 'a', 'resolved');
    expect(result.pass).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/a1/); // names the open child
  });

  test('rejects every closing state onto a parent with an open child, not just resolved', () => {
    let map = emptyMap();
    map = addNode(map, node({ id: 'a', parent_id: 'root' }));
    map = addNode(map, node({ id: 'a1', parent_id: 'a' }));
    expect(coverageClosureGate(map, 'a', 'resolved').pass).toBe(false);
    expect(coverageClosureGate(map, 'a', 'user_owned').pass).toBe(false);
    expect(coverageClosureGate(map, 'a', 'out_of_scope').pass).toBe(false);
  });

  test('admits a resolved projection once the whole subtree is closed (dry)', () => {
    let map = emptyMap();
    map = addNode(map, node({ id: 'a', parent_id: 'root' }));
    map = addNode(map, node({ id: 'a1', parent_id: 'a' }));
    map = closeNode(map, 'a1', 'resolved');
    expect(coverageClosureGate(map, 'a', 'resolved').pass).toBe(true);
  });

  test('admits closing a leaf (no children — trivially dry)', () => {
    let map = emptyMap();
    map = addNode(map, node({ id: 'a', parent_id: 'root' }));
    expect(coverageClosureGate(map, 'a', 'resolved').pass).toBe(true);
  });
});

describe('coverage Manager — termination via admissible-novelty exhaustion (K=2)', () => {
  test('two consecutive admissible-novelty=0 rounds make the dry counter reach K=2', () => {
    let counter = recordDryRound(0, { admissibleBranchesAdded: 0 }); // 1
    expect(counter).toBe(1);
    counter = recordDryRound(counter, { admissibleBranchesAdded: 0 }); // 2 → dry
    expect(counter).toBe(2);
  });

  test('an admissible new branch resets the dry counter; info/low novelty does not', () => {
    let counter = recordDryRound(0, { admissibleBranchesAdded: 0 }); // 1
    // info/low novelty (admissibleBranchesAdded=0) does NOT reset, keeps counting.
    counter = recordDryRound(counter, { admissibleBranchesAdded: 0 }); // 2
    expect(counter).toBe(2);
    // a critical/major admissible new branch resets to 0.
    counter = recordDryRound(counter, { admissibleBranchesAdded: 1 });
    expect(counter).toBe(0);
  });

  test('isCoverageTerminated requires breadth (all closed) AND depth (dry, K reached)', () => {
    let map = emptyMap();
    map = addNode(map, node({ id: 'a', parent_id: 'root' }));
    // all open → not terminated regardless of dry counter.
    expect(isCoverageTerminated(map, 2)).toBe(false);
    map = closeNode(map, 'a', 'resolved');
    map = closeNode(map, 'root', 'resolved');
    // all closed but dry counter below K → not terminated (depth axis fails).
    expect(isCoverageTerminated(map, 1)).toBe(false);
    // all closed AND dry counter >= K=2 → terminated.
    expect(isCoverageTerminated(map, 2)).toBe(true);
  });

  test('the default K is 2 (configurable)', () => {
    let map = emptyMap();
    map = closeNode(map, 'root', 'resolved');
    expect(isCoverageTerminated(map, 2)).toBe(true);
    expect(isCoverageTerminated(map, 1)).toBe(false);
    // explicit K override still honored.
    expect(isCoverageTerminated(map, 3, 3)).toBe(true);
    expect(isCoverageTerminated(map, 2, 3)).toBe(false);
  });
});

// ── ac-3: fresh judge input carries NO accumulated transcript ──────────────────
// §4.1: "각 fresh 서브에이전트에 최소 컨텍스트만 전달: [해당 노드 + 최초 의도 +
// 관련 cross-cutting 제약]. 전체 transcript는 주지 않는다." The deterministic
// input builder must, even when handed an accumulated history, emit an object
// containing ONLY those three fields — never any prior-node transcript content.
describe('coverage Manager — fresh judge input excludes prior transcript (§4.1, ac-3)', () => {
  const SENTINEL = 'PRIOR-NODE-TRANSCRIPT-LEAK-CANARY';

  const accumulated = {
    history: [
      { node_id: 'x', text: `${SENTINEL} producer said ...` },
      { node_id: 'y', text: `${SENTINEL} opponent objected ...` },
    ],
    transcript: `whole running ${SENTINEL} log across all prior nodes`,
    priorVerdicts: [`${SENTINEL} accepted`],
  };

  test('built input contains ONLY {node, original_intent, cross_cutting_constraints}', () => {
    const built = buildJudgeInput({
      node: node({ id: 'a', parent_id: 'root', label: 'auth scope' }),
      originalIntent: 'add login',
      crossCuttingConstraints: ['must not break session model'],
      accumulated,
    });
    expect(Object.keys(built).sort()).toEqual([
      'cross_cutting_constraints',
      'node',
      'original_intent',
    ]);
  });

  test('no accumulated transcript content leaks into the built input (canary absent)', () => {
    const built = buildJudgeInput({
      node: node({ id: 'a', parent_id: 'root', label: 'auth scope' }),
      originalIntent: 'add login',
      crossCuttingConstraints: ['must not break session model'],
      accumulated,
    });
    // serialize the whole built object and assert the prior-transcript canary is gone.
    expect(JSON.stringify(built)).not.toContain(SENTINEL);
    expect(built.node.id).toBe('a');
    expect(built.original_intent).toBe('add login');
    expect(built.cross_cutting_constraints).toEqual(['must not break session model']);
  });

  test('the same input is produced whether or not an accumulated transcript is supplied (zero persistent context)', () => {
    const withHistory = buildJudgeInput({
      node: node({ id: 'a', parent_id: 'root', label: 'auth scope' }),
      originalIntent: 'add login',
      crossCuttingConstraints: ['c1'],
      accumulated,
    });
    const withoutHistory = buildJudgeInput({
      node: node({ id: 'a', parent_id: 'root', label: 'auth scope' }),
      originalIntent: 'add login',
      crossCuttingConstraints: ['c1'],
    });
    expect(withHistory).toEqual(withoutHistory);
  });
});

// ── ac-4: each of the 6 axes is enforced by its OWN distinct mechanism ──────────
// §2: "각 축은 별도 메커니즘으로만 막힌다 — 체크리스트 하나로는 못 막는다." The
// dispatch registry must map every axis key to a separately-invoked mechanism,
// not one shared catch-all.
describe('coverage Manager — 6 axes each map to a distinct mechanism (§2, ac-4)', () => {
  test('all six contract axes are present as keys', () => {
    expect(COVERAGE_AXES.map((a) => a as string).sort()).toEqual(
      ['balance', 'completeness', 'discovery', 'neutrality', 'priority', 'temporal'].sort(),
    );
  });

  test('every axis resolves to a mechanism entry (no axis left unenforced)', () => {
    for (const axis of COVERAGE_AXES) {
      expect(COVERAGE_AXIS_MECHANISMS[axis]).toBeDefined();
      expect(typeof COVERAGE_AXIS_MECHANISMS[axis].enforce).toBe('function');
    }
  });

  test('each axis maps to a DISTINCT mechanism — no shared catch-all', () => {
    const mechanismIds = COVERAGE_AXES.map((a) => COVERAGE_AXIS_MECHANISMS[a].mechanism_id);
    expect(new Set(mechanismIds).size).toBe(COVERAGE_AXES.length);
    // distinct enforce functions too (not one function aliased six times).
    const fns = COVERAGE_AXES.map((a) => COVERAGE_AXIS_MECHANISMS[a].enforce);
    expect(new Set(fns).size).toBe(COVERAGE_AXES.length);
  });

  test('neutrality reuses the opponent-router (3-role dialectic), not a fresh duplicate', () => {
    expect(COVERAGE_AXIS_MECHANISMS.neutrality.mechanism_id).toMatch(/opponent-router|dialectic/);
  });

  test('discovery is the loop-until-dry mechanism (admissible-novelty exhaustion)', () => {
    // the discovery axis enforce delegates to the dry-round counter (recordDryRound):
    // a round adding an admissible branch resets, an empty round increments.
    const reset = COVERAGE_AXIS_MECHANISMS.discovery.enforce({ admissibleBranchesAdded: 1 });
    const step = COVERAGE_AXIS_MECHANISMS.discovery.enforce({ admissibleBranchesAdded: 0 });
    expect(reset).toBe(0);
    expect(step).toBe(1);
  });
});

// ── ac-4 (BEHAVIORAL): each axis mechanism actually REJECTS a violation and
// ADMITS a satisfying case (§2 강제 — not merely 6 distinct function references).
// The "distinct id/fn" test above is necessary but not sufficient: a placeholder
// that echoes a caller boolean would pass it while enforcing nothing. These
// tests exercise each axis's enforcement against a concrete violation.
describe('coverage Manager — each of the 6 axes ENFORCES against a violation (§2, ac-4)', () => {
  // completeness — every node must close AND dry counter reach K to terminate.
  test('completeness REJECTS an open node / sub-K dry; ADMITS all-closed AND dry', () => {
    let map = emptyMap();
    map = addNode(map, node({ id: 'a', parent_id: 'root' }));
    // violation: an open node — not terminated regardless of dry counter.
    expect(COVERAGE_AXIS_MECHANISMS.completeness.enforce(map, 2)).toBe(false);
    map = closeNode(map, 'a', 'resolved');
    map = closeNode(map, 'root', 'resolved');
    // violation: all closed but dry counter below K (depth axis fails).
    expect(COVERAGE_AXIS_MECHANISMS.completeness.enforce(map, 1)).toBe(false);
    // satisfying: all closed AND dry.
    expect(COVERAGE_AXIS_MECHANISMS.completeness.enforce(map, 2)).toBe(true);
  });

  // neutrality — a real 3-role dialectic verdict must exist for the node; a
  // missing/blocked deliberation is REJECTED (no echo of a precomputed bool).
  test('neutrality REJECTS a missing/blocked dialectic; ADMITS a decided 3-role verdict', () => {
    // violation A: no dialectic produced for the node at all.
    expect(COVERAGE_AXIS_MECHANISMS.neutrality.enforce(undefined)).toBe(false);
    // violation B: deliberation blocked (no Opponent could run — §3.2 of dialectic).
    expect(
      COVERAGE_AXIS_MECHANISMS.neutrality.enforce({
        opponent_ran: true,
        verdict: 'blocked',
      }),
    ).toBe(false);
    // violation C: a verdict claimed but the Opponent never ran (single-agent
    // role-play — exactly the bias the axis blocks).
    expect(
      COVERAGE_AXIS_MECHANISMS.neutrality.enforce({
        opponent_ran: false,
        verdict: 'accept',
      }),
    ).toBe(false);
    // satisfying: Opponent ran AND the Synthesizer reached a decided verdict.
    expect(
      COVERAGE_AXIS_MECHANISMS.neutrality.enforce({
        opponent_ran: true,
        verdict: 'accept',
      }),
    ).toBe(true);
  });

  // balance — depth proportional to need (depth_weight), floor-capped so a
  // high self-reported depth cannot escape unresolved ambiguity (deterministicFloor).
  test('balance REJECTS a shallow high-weight node; ADMITS a node that meets its need', () => {
    const heavy = node({ id: 'a', depth_weight: 0.9 });
    // violation: achieved depth below the node's required weight.
    expect(
      COVERAGE_AXIS_MECHANISMS.balance.enforce(heavy, {
        achievedDepth: 0.3,
        open_required_sections: 0,
        conflicting: 0,
        assumption_ratio: 0,
      }),
    ).toBe(false);
    // violation: nominally deep, but the deterministic floor (open critical scope)
    // caps the achieved depth below the requirement — score-high/critical-unresolved.
    expect(
      COVERAGE_AXIS_MECHANISMS.balance.enforce(heavy, {
        achievedDepth: 0.95,
        open_required_sections: 3,
        conflicting: 0,
        assumption_ratio: 0,
      }),
    ).toBe(false);
    // satisfying: achieved depth meets the weight and the floor is clean.
    expect(
      COVERAGE_AXIS_MECHANISMS.balance.enforce(heavy, {
        achievedDepth: 0.95,
        open_required_sections: 0,
        conflicting: 0,
        assumption_ratio: 0,
      }),
    ).toBe(true);
  });

  // discovery — loop-until-dry: an admissible new branch resets, an empty round increments.
  test('discovery REJECTS (resets) on a new admissible branch; counts an empty round', () => {
    expect(COVERAGE_AXIS_MECHANISMS.discovery.enforce({ admissibleBranchesAdded: 2 })).toBe(0);
    expect(COVERAGE_AXIS_MECHANISMS.discovery.enforce({ admissibleBranchesAdded: 0 })).toBe(1);
  });

  // priority — a high-priority node that is shallow blocks termination (§2 우선순위).
  test('priority REJECTS a shallow high-priority node; ADMITS when it meets weighted depth', () => {
    const important = node({ id: 'a', depth_weight: 0.8 });
    const trivial = node({ id: 'b', depth_weight: 0.1 });
    // violation: high-priority + high weight but shallow → blocks.
    expect(
      COVERAGE_AXIS_MECHANISMS.priority.enforce(important, {
        userPriority: 'high',
        achievedDepth: 0.2,
      }),
    ).toBe(false);
    // satisfying: high-priority node that reached its weighted depth.
    expect(
      COVERAGE_AXIS_MECHANISMS.priority.enforce(important, {
        userPriority: 'high',
        achievedDepth: 0.85,
      }),
    ).toBe(true);
    // a low-priority shallow node does NOT block on the priority axis.
    expect(
      COVERAGE_AXIS_MECHANISMS.priority.enforce(trivial, {
        userPriority: 'normal',
        achievedDepth: 0,
      }),
    ).toBe(true);
  });

  // temporal — frozen baseline + divergence detection. The engine FREEZES the
  // baseline and DETECTS divergence; it does not itself enforce drift (that is
  // the implementation stage's job, §2 line 62). REJECT a diverged surface.
  test('temporal REJECTS divergence from the frozen baseline; ADMITS an unchanged surface', () => {
    const baseline = ['POST /login', 'class Session'];
    // satisfying: current surface equals the frozen baseline (no divergence).
    expect(
      COVERAGE_AXIS_MECHANISMS.temporal.enforce(baseline, ['POST /login', 'class Session']),
    ).toBe(true);
    // violation: an interface added downstream that was not in the frozen baseline.
    expect(
      COVERAGE_AXIS_MECHANISMS.temporal.enforce(baseline, [
        'POST /login',
        'class Session',
        'DELETE /login',
      ]),
    ).toBe(false);
    // violation: an interface removed downstream.
    expect(COVERAGE_AXIS_MECHANISMS.temporal.enforce(baseline, ['POST /login'])).toBe(false);
  });

  // honesty: temporal's mechanism_id must NOT over-claim drift ENFORCEMENT —
  // the engine freezes/compares; drift enforcement proper is downstream (§2 l.62).
  test('temporal mechanism_id is honest: freeze + divergence detection, not drift enforcement', () => {
    const id = COVERAGE_AXIS_MECHANISMS.temporal.mechanism_id;
    expect(id).toMatch(/freeze/);
    expect(id).toMatch(/diverg/);
    // it does not claim to ENFORCE drift (that is the implementation stage's job).
    expect(id).not.toMatch(/drift-enforce|enforce-drift/);
  });
});

// ── ac-6: plan-dialog.md serialization carries all 4 sections ───────────────────
// §6: the Manager serializes (does NOT interpret) the plan-stage dialog into a md
// containing four sections: (1) 사용자 Q&A, (2) QuestionGate self-answer (안 물은
// 근거 = source/result/reason it was self-answered instead of asked), (3)
// assumptions (hypothesis-labeled), (4) 열린/닫힌 항목 (both closed AND still-open).
// The serializer takes already-structured fields and renders them deterministically.
describe('coverage Manager — plan-dialog.md serialization (§6, ac-6)', () => {
  const buildInput = () => ({
    workItemId: 'wi_test',
    userQa: [
      {
        question: 'Should the brief gate auto-approve light changes?',
        why_matters: 'decides whether implement waits on user',
        answer: 'yes, auto-approve light',
      },
    ],
    selfAnswers: [
      {
        question: 'What is the existing approval_gate field name?',
        why_not_asked: 'answerable from code, not a value judgement',
        attempts: [{ source: 'code' as const, result: 'autopilot.ts:159 approval_gate exists' }],
      },
    ],
    assumptions: [
      {
        statement: 'reviewer enforces drift against the frozen baseline',
        label: 'hypothesis' as const,
        because_no_answer_to: 'q-drift-owner',
      },
    ],
    closedItems: [{ id: 'a', label: 'interface surface', state: 'resolved' as const }],
    openItems: [{ id: 'b', label: 'failure modes', state: 'open' as const }],
  });

  test('serialized md contains all four §6 sections', () => {
    const md = serializePlanDialog(buildInput());
    // (1) 사용자 Q&A
    expect(md).toContain('사용자 Q&A');
    // (2) QuestionGate self-answer (안 물은 근거)
    expect(md).toContain('QuestionGate self-answer');
    // (3) assumptions
    expect(md).toMatch(/assumptions/i);
    // (4) 열린/닫힌 항목 — both must appear
    expect(md).toMatch(/닫힌 항목/);
    expect(md).toMatch(/열린 항목/);
  });

  test('each section renders its structured content verbatim (no interpretation)', () => {
    const md = serializePlanDialog(buildInput());
    // user Q&A Q→A content present.
    expect(md).toContain('Should the brief gate auto-approve light changes?');
    expect(md).toContain('yes, auto-approve light');
    // self-answer carries the question, the 안 물은 근거, and the source/result evidence.
    expect(md).toContain('What is the existing approval_gate field name?');
    expect(md).toContain('answerable from code, not a value judgement');
    expect(md).toContain('autopilot.ts:159 approval_gate exists');
    // assumption statement + hypothesis label + the unanswered question it traces to.
    expect(md).toContain('reviewer enforces drift against the frozen baseline');
    expect(md).toContain('hypothesis');
    expect(md).toContain('q-drift-owner');
    // open/closed items both render their labels.
    expect(md).toContain('interface surface');
    expect(md).toContain('failure modes');
  });

  test('a frontmatter title marks the artifact and names the work item', () => {
    const md = serializePlanDialog(buildInput());
    expect(md.startsWith('---')).toBe(true);
    expect(md).toContain('wi_test');
    expect(md).toContain('plan-dialog');
  });

  test('empty sections still render their headers (open/closed both shown even if empty)', () => {
    const md = serializePlanDialog({
      workItemId: 'wi_empty',
      userQa: [],
      selfAnswers: [],
      assumptions: [],
      closedItems: [],
      openItems: [],
    });
    expect(md).toContain('사용자 Q&A');
    expect(md).toContain('QuestionGate self-answer');
    expect(md).toMatch(/assumptions/i);
    expect(md).toMatch(/닫힌 항목/);
    expect(md).toMatch(/열린 항목/);
  });
});

// ── ac-8: cost control — three tiers + caps, breadth-invariant ──────────────────
// §8.2: lightweight 3등급(light/standard/full, 규모+risk 기반) + caps 상한(노드당
// 호출 수·트리 노드 수·총 라운드 수). light는 brief를 not_required로 자동승인.
// 핵심 불변식: 경량화·상한은 넓이(breadth)는 안 줄이고 깊이(depth)만 줄인다.
describe('coverage Manager — tier selection from size+risk (§8.2, ac-8)', () => {
  const noRisk = { non_local: false, irreversible: false, unaudited: false };

  test('the three contract tiers are present', () => {
    expect(COVERAGE_TIERS.map((t) => t as string).sort()).toEqual(['full', 'light', 'standard']);
  });

  test('light: few files ∧ no interface change ∧ all risk axes negative', () => {
    expect(
      selectCoverageTier({
        changedFileCount: 1,
        interfaceChanged: false,
        risk: noRisk,
        large: false,
      }),
    ).toBe('light');
  });

  test('standard: a risk axis positive (but not irreversible/non_local) lifts off light', () => {
    expect(
      selectCoverageTier({
        changedFileCount: 1,
        interfaceChanged: false,
        risk: { ...noRisk, unaudited: true },
        large: false,
      }),
    ).toBe('standard');
  });

  test('standard: interface change alone (small, no risk) is not light', () => {
    expect(
      selectCoverageTier({
        changedFileCount: 1,
        interfaceChanged: true,
        risk: noRisk,
        large: false,
      }),
    ).toBe('standard');
  });

  test('full: large scope escalates regardless of risk', () => {
    expect(
      selectCoverageTier({
        changedFileCount: 99,
        interfaceChanged: false,
        risk: noRisk,
        large: true,
      }),
    ).toBe('full');
  });

  test('full: irreversible OR non_local forces full even when small', () => {
    expect(
      selectCoverageTier({
        changedFileCount: 1,
        interfaceChanged: false,
        risk: { ...noRisk, irreversible: true },
        large: false,
      }),
    ).toBe('full');
    expect(
      selectCoverageTier({
        changedFileCount: 1,
        interfaceChanged: false,
        risk: { ...noRisk, non_local: true },
        large: false,
      }),
    ).toBe('full');
  });
});

describe('coverage Manager — light tier auto-approves the brief (§7.2/§8.2, ac-8)', () => {
  test('light maps the brief gate to not_required (small-reversible auto-waiver)', () => {
    expect(tierBriefApproval('light')).toBe('not_required');
  });

  test('standard and full require explicit user approval (pending, not waived)', () => {
    expect(tierBriefApproval('standard')).toBe('pending');
    expect(tierBriefApproval('full')).toBe('pending');
  });
});

describe('coverage Manager — caps bound depth and never read as converged (§5/§8.2, ac-8)', () => {
  const caps = { callsPerNode: 3, treeNodeCount: 10, totalRounds: 5 };

  test('a run within every cap is not capped (and so does not stop on caps)', () => {
    const s = capStatus(caps, { callsThisNode: 2, treeNodeCount: 8, roundsRun: 4 });
    expect(s.capped).toBe(false);
    expect(s.converged).toBe(false); // a cap check never asserts convergence
  });

  test('hitting the per-node call cap stops — and is NOT converged (cap ≠ converged)', () => {
    const s = capStatus(caps, { callsThisNode: 3, treeNodeCount: 8, roundsRun: 4 });
    expect(s.capped).toBe(true);
    expect(s.converged).toBe(false);
    expect(s.reasons.join(' ')).toMatch(/call/i);
  });

  test('hitting the tree-node-count cap stops — NOT converged', () => {
    const s = capStatus(caps, { callsThisNode: 1, treeNodeCount: 10, roundsRun: 1 });
    expect(s.capped).toBe(true);
    expect(s.converged).toBe(false);
    expect(s.reasons.join(' ')).toMatch(/node/i);
  });

  test('hitting the total-rounds cap stops — NOT converged', () => {
    const s = capStatus(caps, { callsThisNode: 1, treeNodeCount: 1, roundsRun: 5 });
    expect(s.capped).toBe(true);
    expect(s.converged).toBe(false);
    expect(s.reasons.join(' ')).toMatch(/round/i);
  });

  test('a cap hit is escalation, not termination: isCoverageTerminated still needs all-closed AND dry', () => {
    // a tree with an open node + a hit cap must NOT be reported terminated — the
    // contract forbids treating a cap as converged/pass.
    let map = emptyMap();
    map = addNode(map, node({ id: 'a', parent_id: 'root' })); // open
    const s = capStatus(caps, { callsThisNode: 3, treeNodeCount: 8, roundsRun: 5 });
    expect(s.capped).toBe(true);
    // termination is independent of caps and still false here (open node).
    expect(isCoverageTerminated(map, 2)).toBe(false);
  });
});

describe('coverage Manager — breadth-invariant: tier shrinks depth only (§8.2, ac-8)', () => {
  test('the 6 axes are identical across all tiers — no axis dropped by a lower tier', () => {
    // breadth = the axis set. tierDepthBudget must return the SAME axes for every
    // tier; only the depth knobs (rounds/judge passes) differ. §8.2: 넓이 불변.
    const axesByTier = COVERAGE_TIERS.map((t) => tierDepthBudget(t).axes);
    for (const axes of axesByTier) {
      expect([...axes].sort()).toEqual([...COVERAGE_AXES].sort());
    }
  });

  test('depth knobs monotonically shrink light ≤ standard ≤ full (depth-only reduction)', () => {
    const light = tierDepthBudget('light');
    const standard = tierDepthBudget('standard');
    const full = tierDepthBudget('full');
    // rounds (depth) shrink as the tier lowers …
    expect(light.maxRoundsPerNode).toBeLessThanOrEqual(standard.maxRoundsPerNode);
    expect(standard.maxRoundsPerNode).toBeLessThanOrEqual(full.maxRoundsPerNode);
    // … and sweep angles (a depth-of-decomposition knob) likewise shrink.
    expect(light.sweepAngles).toBeLessThanOrEqual(standard.sweepAngles);
    expect(standard.sweepAngles).toBeLessThanOrEqual(full.sweepAngles);
  });

  test('lowering the tier never reduces the axis COUNT (breadth count constant)', () => {
    const counts = COVERAGE_TIERS.map((t) => tierDepthBudget(t).axes.length);
    expect(new Set(counts).size).toBe(1); // all tiers carry the same axis count
    expect(counts[0]).toBe(COVERAGE_AXES.length);
  });
});
