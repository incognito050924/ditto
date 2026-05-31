/**
 * v0 구현 계획 적합성(conformance) 테스트 — Milestone 2 (autopilot skeleton).
 * plan §4 의 각 build unit acceptance 를 문서에서 직접 인코딩한다.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapAutopilot } from '~/core/autopilot-bootstrap';
import { buildDelegationPacket, decideOnFailure } from '~/core/autopilot-dispatch';
import {
  allNodesTerminal,
  buildContinuationSignal,
  mutationGate,
  nextReadyNodeId,
} from '~/core/autopilot-driver';
import { buildInitialNodes, kindToOwner, selectReadyNode } from '~/core/autopilot-graph';
import { AutopilotStore } from '~/core/autopilot-store';
import { WorkItemStore } from '~/core/work-item-store';
import { autopilotForcesContinuation } from '~/hooks/stop';
import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';
import type { IntentContract } from '~/schemas/intent';
import type { WorkItem } from '~/schemas/work-item';

let tmp: string;
let store: WorkItemStore;
let wi: WorkItem;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ditto-conf-m2-'));
  store = new WorkItemStore(tmp);
  wi = await store.create({
    title: 'pw endpoint',
    source_request: 'add endpoint',
    goal: 'endpoint returns score',
    acceptance_criteria: [
      {
        id: 'AC-1',
        statement: 'returns 200 with a numeric score',
        verdict: 'unverified',
        evidence: [],
      },
      {
        id: 'AC-2',
        statement: 'rejects empty body with exit code 1',
        verdict: 'unverified',
        evidence: [],
      },
    ],
  });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// observable AC 를 가진 ready intent.
const readyIntent = (): IntentContract => ({
  schema_version: '0.1.0',
  work_item_id: wi.id,
  source_request: 'add endpoint',
  goal: 'POST /password/check returns a strength score',
  in_scope: [],
  out_of_scope: [],
  acceptance_criteria: [
    {
      id: 'AC-1',
      statement: 'returns 200 with a numeric score',
      verdict: 'unverified',
      evidence: [],
      evidence_required: ['test'],
    },
  ],
  unknowns: [],
  follow_up_candidates: [],
  question_policy: 'ask_only_if_user_only_can_answer',
});

const SAFE = { non_local: false, irreversible: false, unaudited: false };
const RISKY = { non_local: false, irreversible: true, unaudited: false };

// ─────────────────────────────────────────────────────────────────────────
describe('M2.1 — autopilot.json 스키마 소비 + AutopilotStore (glue)', () => {
  // acceptance: store 통해서만 노드 상태 변경; 직접 덮어쓰기 차단(인터페이스); M0.2 스키마 재사용.
  test('write → get 라운드트립 (스키마 검증된 mutation 단일 경로)', async () => {
    const { graph } = (await bootstrapAutopilot(tmp, {
      workItem: wi,
      intent: readyIntent(),
      risk: SAFE,
    })) as { graph: Autopilot };
    const fetched = await new AutopilotStore(tmp).get(wi.id);
    expect(fetched.autopilot_id).toBe(graph.autopilot_id);
    expect(fetched.nodes.length).toBe(graph.nodes.length);
  });

  test('updateNode: 한 노드만 변경, node id 변경 시 throw', async () => {
    await bootstrapAutopilot(tmp, { workItem: wi, intent: readyIntent(), risk: SAFE });
    const s = new AutopilotStore(tmp);
    const updated = await s.updateNode(wi.id, 'N1', (n) => ({ ...n, status: 'passed' }));
    expect(updated.nodes.find((n) => n.id === 'N1')?.status).toBe('passed');
    const rejects = async (p: Promise<unknown>): Promise<boolean> => {
      try {
        await p;
        return false;
      } catch {
        return true;
      }
    };
    expect(await rejects(s.updateNode(wi.id, 'N2', (n) => ({ ...n, id: 'X' })))).toBe(true);
    expect(await rejects(s.updateNode(wi.id, 'NOPE', (n) => n))).toBe(true);
  });

  test('autopilot-decisions.jsonl: append-only, 순서 보존', async () => {
    const s = new AutopilotStore(tmp);
    const mk = (node_id: string) => ({
      ts: new Date().toISOString(),
      node_id,
      failure_class: 'fixable' as const,
      decision: 'retry' as const,
      reason: 'r',
      attempts: { fix: 1, switch: 0 },
    });
    await s.appendDecision(wi.id, mk('N1'));
    await s.appendDecision(wi.id, mk('N2'));
    const log = await s.readDecisions(wi.id);
    expect(log.map((d) => d.node_id)).toEqual(['N1', 'N2']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M2.1b — autopilot 그래프 bootstrap (intent → graph → approval)', () => {
  // acceptance: ready intent → graph 생성(root_goal·nodes·approval); high-risk→pending,
  //             safe→not_required, 승인입력→approved; vague intent → graph 미생성.
  test('ready intent → graph 생성 (root_goal · plan→implement→verify nodes)', async () => {
    const res = await bootstrapAutopilot(tmp, { workItem: wi, intent: readyIntent(), risk: SAFE });
    expect(res.status).toBe('created');
    if (res.status !== 'created') return;
    expect(res.graph.root_goal).toBe(readyIntent().goal);
    expect(res.graph.nodes.map((n) => n.kind)).toEqual(['design', 'implement', 'verify']);
    expect(res.graph.work_item_id).toBe(wi.id);
  });

  test('high-risk → approval pending', async () => {
    const res = await bootstrapAutopilot(tmp, { workItem: wi, intent: readyIntent(), risk: RISKY });
    expect(res.status === 'created' && res.graph.approval_gate.status).toBe('pending');
  });

  test('safe-defaultable → approval not_required', async () => {
    const res = await bootstrapAutopilot(tmp, { workItem: wi, intent: readyIntent(), risk: SAFE });
    expect(res.status === 'created' && res.graph.approval_gate.status).toBe('not_required');
  });

  test('이미 승인된 입력(approvedSource) → approval approved', async () => {
    const res = await bootstrapAutopilot(tmp, {
      workItem: wi,
      intent: readyIntent(),
      risk: RISKY,
      approvedSource: 'user',
    });
    expect(res.status === 'created' && res.graph.approval_gate.status).toBe('approved');
  });

  test('vague/모호 intent → graph 미생성(intent_not_ready, interview로 회송)', async () => {
    const vague: IntentContract = {
      ...readyIntent(),
      acceptance_criteria: [
        {
          id: 'AC-1',
          statement: 'should be robust and user-friendly',
          verdict: 'unverified',
          evidence: [],
          evidence_required: [],
        },
      ],
    };
    const res = await bootstrapAutopilot(tmp, { workItem: wi, intent: vague, risk: SAFE });
    expect(res.status).toBe('intent_not_ready');
    expect(await new AutopilotStore(tmp).exists(wi.id)).toBe(false);
  });

  test('생성된 graph 가 M2.2 루프 입력으로 동작 (첫 ready 노드 선택 가능)', async () => {
    const res = await bootstrapAutopilot(tmp, { workItem: wi, intent: readyIntent(), risk: SAFE });
    if (res.status !== 'created') throw new Error('expected created');
    expect(selectReadyNode(res.graph.nodes)?.id).toBe('N1');
  });

  test('ditto deep-interview finalize 가 bootstrapAutopilot 을 자동 호출한다 (§AC-3, wi_v04intent_autopilot_entry 2026-06-01)', async () => {
    const { startInterview, recordTurn, finalizeInterview } = await import(
      '~/core/interview-driver'
    );
    const { AutopilotStore } = await import('~/core/autopilot-store');
    const { IntentStore } = await import('~/core/intent-store');
    await startInterview(tmp, { workItemId: wi.id });
    await recordTurn(tmp, {
      workItemId: wi.id,
      payload: {
        dimension: {
          id: 'd-shape',
          critical: true,
          state: 'resolved',
          ambiguity: 0.05,
          notes: '',
        },
        question: {
          text: 'shape?',
          why_matters: 'response contract',
          info_gain_estimate: 'high',
        },
        answer: { text: 'integer 0..100', kind: 'user' },
        readiness_score: 0.85,
      },
    });
    const result = await finalizeInterview(tmp, {
      workItemId: wi.id,
      payload: {
        goal: 'returns integer score 0..100',
        in_scope: [],
        out_of_scope: [],
        acceptance_criteria: [
          {
            id: 'ac-1',
            statement: 'returns integer 0..100',
            verdict: 'unverified',
            evidence: [],
            evidence_required: ['test'],
          },
        ],
        unknowns: [],
        follow_up_candidates: [],
        question_policy: 'ask_only_if_user_only_can_answer',
        risk: { non_local: false, irreversible: false, unaudited: false },
      },
    });
    expect(result.status).toBe('finalized');
    // 한 호출로 intent.json + autopilot.json 둘 다 생성됨.
    expect(await new IntentStore(tmp).exists(wi.id)).toBe(true);
    expect(await new AutopilotStore(tmp).exists(wi.id)).toBe(true);
    if (result.status === 'finalized') {
      expect(result.autopilot.work_item_id).toBe(wi.id);
      expect(result.autopilot.root_goal).toBe('returns integer score 0..100');
      expect(result.autopilot.approval_gate.status).toBe('not_required');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M2.2 — autopilot 드라이버 ReAct 루프 (ready 선택·depends_on·continuation)', () => {
  // acceptance: ready 노드 선택→상태 갱신→다음 노드 루프; 내부 checkpoint 만으로 종료 안 함.
  const chain = (): AutopilotNode[] => buildInitialNodes(['AC-1']);

  test('kind→owner 매핑 (research→researcher … verify→verifier)', () => {
    expect(kindToOwner('design')).toBe('planner');
    expect(kindToOwner('implement')).toBe('implementer');
    expect(kindToOwner('verify')).toBe('verifier');
  });

  test('depends_on 미충족 노드는 선택되지 않는다', () => {
    const nodes = chain(); // N1(design) ← N2 ← N3
    expect(selectReadyNode(nodes)?.id).toBe('N1'); // N2/N3 deps not passed
  });

  test('N1 passed → N2 ready → N3 ready → 모두 passed 시 null + terminal', () => {
    let nodes = chain();
    const pass = (id: string) =>
      nodes.map((n) => (n.id === id ? { ...n, status: 'passed' as const } : n));
    nodes = pass('N1');
    expect(selectReadyNode(nodes)?.id).toBe('N2');
    nodes = pass('N2');
    expect(selectReadyNode(nodes)?.id).toBe('N3');
    nodes = pass('N3');
    expect(selectReadyNode(nodes)).toBeNull();
    expect(allNodesTerminal({ nodes } as Autopilot)).toBe(true);
  });

  test('실행 가능한 노드가 남아있고 approval pending 아니면 Stop continuation 강제(루프 유지)', async () => {
    const res = await bootstrapAutopilot(tmp, { workItem: wi, intent: readyIntent(), risk: SAFE });
    if (res.status !== 'created') throw new Error('expected created');
    expect(autopilotForcesContinuation(res.graph)).toBe(true); // 내부 checkpoint 만으로 종료 안 함
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M2.3 — plan approval gate (status 소비만, risk 재판정 안 함)', () => {
  // acceptance: pending → mutation 미실행 + plan 제시; approved/not_required → 무중단 진행.
  const graphWith = (status: Autopilot['approval_gate']['status']): Autopilot =>
    ({
      approval_gate: {
        status,
        source: null,
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
      },
    }) as Autopilot;

  test('pending → 차단 + present_plan', () => {
    const g = mutationGate(graphWith('pending'));
    expect(g.allowed).toBe(false);
    expect(g.action).toBe('present_plan');
  });

  test('approved / not_required → proceed (무중단)', () => {
    expect(mutationGate(graphWith('approved')).action).toBe('proceed');
    expect(mutationGate(graphWith('not_required')).action).toBe('proceed');
    expect(mutationGate(graphWith('approved')).allowed).toBe(true);
  });

  test('rejected → blocked', () => {
    expect(mutationGate(graphWith('rejected')).action).toBe('blocked');
  });

  test('mutationGate 는 graph 의 기록된 status 만 소비 (risk 입력 인자 없음)', () => {
    // M2.3 은 high-risk 를 새로 판정하지 않는다 → 함수는 graph 하나만 받는다.
    expect(mutationGate.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M2.4 — 노드 dispatch(6-section packet) + 실패 분류', () => {
  // acceptance: 6-section packet; fixable→retry, wrong_approach→switch, cap 초과→non-pass.
  const node = (over: Partial<AutopilotNode>): AutopilotNode => ({
    id: 'N1',
    kind: 'implement',
    owner: 'implementer',
    purpose: 'do it',
    status: 'pending',
    depends_on: [],
    acceptance_refs: ['AC-1'],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
    ...over,
  });

  test('delegation packet 은 6 section + context(work_item_id·file_scope·done_when·acceptance_refs)', () => {
    const p = buildDelegationPacket(node({}), wi);
    expect(p.task).toBeTruthy();
    expect(p.expected_outcome).toBeTruthy();
    expect(Array.isArray(p.required_tools)).toBe(true);
    expect(Array.isArray(p.must_do)).toBe(true);
    expect(Array.isArray(p.must_not_do)).toBe(true);
    expect(p.context.work_item_id).toBe(wi.id);
    expect(p.context).toHaveProperty('file_scope');
    expect(p.context).toHaveProperty('done_when');
    expect(p.context.acceptance_refs).toEqual(['AC-1']);
  });

  test('read-only owner 는 mutate 금지 MUST NOT, implementer 는 Edit/Write 보유', () => {
    const impl = buildDelegationPacket(node({ owner: 'implementer' }), wi).required_tools;
    expect(impl.includes('Edit') && impl.includes('Write')).toBe(true);
    const reviewer = buildDelegationPacket(node({ owner: 'reviewer', kind: 'review' }), wi);
    expect(reviewer.must_not_do.some((m) => /mutate files/i.test(m))).toBe(true);
  });

  test('decideOnFailure: fixable<cap→retry, cap 도달→escalate+cap_exceeded', () => {
    const caps = { fix_per_node: 2, switch_per_node: 1 };
    expect(decideOnFailure('fixable', { fix: 0, switch: 0 }, caps)).toEqual({
      decision: 'retry',
      cap_exceeded: false,
    });
    expect(decideOnFailure('fixable', { fix: 2, switch: 0 }, caps)).toEqual({
      decision: 'escalate',
      cap_exceeded: true,
    });
  });

  test('decideOnFailure: wrong_approach→switch, cap 도달→escalate; external/user_decision→escalate', () => {
    const caps = { fix_per_node: 2, switch_per_node: 1 };
    expect(decideOnFailure('wrong_approach', { fix: 0, switch: 0 }, caps).decision).toBe(
      'switch_approach',
    );
    expect(decideOnFailure('wrong_approach', { fix: 0, switch: 1 }, caps)).toEqual({
      decision: 'escalate',
      cap_exceeded: true,
    });
    expect(decideOnFailure('blocked_external', { fix: 0, switch: 0 }, caps).decision).toBe(
      'escalate',
    );
    expect(decideOnFailure('user_decision_needed', { fix: 0, switch: 0 }, caps).decision).toBe(
      'escalate',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M2.5 — checkpoint 자동 continuation + handoff 신호 (artifact 생성은 M4)', () => {
  // acceptance: plan→implement→verify 개입 없이 연결; context pressure/cap 시 handoff_required/
  //             re_entry_required 신호만 남기고(같은 autopilot_id resume) continuation 멈춤.
  test('passed 노드 후 다음 ready 노드 자동 선택 (nextReadyNodeId)', () => {
    const nodes = buildInitialNodes(['AC-1']).map((n) =>
      n.id === 'N1' ? { ...n, status: 'passed' as const } : n,
    );
    expect(nextReadyNodeId({ nodes } as Autopilot)).toBe('N2');
  });

  test('buildContinuationSignal: handoff/re_entry 신호 + 같은 autopilot_id resume(scope 불변)', async () => {
    const res = await bootstrapAutopilot(tmp, { workItem: wi, intent: readyIntent(), risk: SAFE });
    if (res.status !== 'created') throw new Error('expected created');
    const sig = buildContinuationSignal(res.graph, 'context pressure');
    expect(sig.handoff_required).toBe(true);
    expect(sig.re_entry_required).toBe(true);
    expect(sig.resume.autopilot_id).toBe(res.graph.autopilot_id); // 같은 id 로 이어받음
    expect(sig.resume.work_item_id).toBe(wi.id);
  });

  test('M2.5 단계는 handoff artifact 파일을 만들지 않는다 (그것은 M4 runtime)', async () => {
    const res = await bootstrapAutopilot(tmp, { workItem: wi, intent: readyIntent(), risk: SAFE });
    if (res.status !== 'created') throw new Error('expected created');
    buildContinuationSignal(res.graph, 'cap exceeded');
    // 신호 생성은 순수 함수 — handoff.md 같은 아티팩트가 디스크에 생기면 안 된다.
    expect(await Bun.file(join(tmp, '.ditto', 'work-items', wi.id, 'handoff.md')).exists()).toBe(
      false,
    );
  });
});
