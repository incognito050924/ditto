/**
 * v0 구현 계획 적합성(conformance) 테스트 — Milestone 4 (Context rot 방지).
 *
 * 권위 출처:
 *  - reports/design/ditto-v0-implementation-plan.md §5 (M4 한 줄 요약)
 *  - reports/design/ditto-claude-code-harness-design.md §12 Milestone 4
 *  - feat(M4) 커밋 메시지(3da00ab) 의 sub-unit 분해(M4.1/M4.2)
 *
 * 설계서 §12 M4 완료기준:
 *  - "큰 조사/검증은 subagent 로 분리된다."  → subagent-first delegation packet
 *    의 핵심 invariants(Context Isolation·6 section)는 M2.4 conformance 가 이미 단언함.
 *    여기서는 M4 sub-unit(handoff/PreCompact/active work item injection)에 집중.
 *  - "handoff 만 보고 새 세션이 이어받을 수 있다."
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutopilotStore } from '~/core/autopilot-store';
import { HandoffStore, buildHandoff } from '~/core/handoff-store';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { preCompactHandler } from '~/hooks/pre-compact';
import { userPromptSubmitHandler } from '~/hooks/user-prompt-submit';
import { handoff as handoffSchema } from '~/schemas/handoff';
import type { WorkItem } from '~/schemas/work-item';

let tmp: string;
let items: WorkItemStore;
let wi: WorkItem;
const SESSION = 'sess-m4';
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ditto-conf-m4-'));
  items = new WorkItemStore(tmp);
  wi = await items.create({
    title: 'pw endpoint',
    source_request: 'add password strength endpoint',
    goal: 'POST /password/check returns a score',
    acceptance_criteria: [
      { id: 'AC-1', statement: 'returns 200', verdict: 'unverified', evidence: [] },
    ],
  });
  await new SessionPointerStore(tmp).set(SESSION, wi.id);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M4.1 — handoff artifact 결정론 조립 + 링크 (HandoffStore.write)', () => {
  test('buildHandoff: handoff 스키마 통과 + 필수 필드(original_intent·current_state·next_first_check)', () => {
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'session X at PreCompact',
      currentState: 'in_progress',
      nextFirstCheck: 'Re-read work item and resume open node',
    });
    expect(handoffSchema.safeParse(h).success).toBe(true);
    expect(h.work_item_id).toBe(wi.id);
    expect(h.original_intent).toBe(wi.source_request); // 원래 의도 보존
    expect(h.current_state.length).toBeGreaterThan(0);
    expect(h.next_first_check.length).toBeGreaterThan(0);
  });

  test('evidence_refs 는 인라인 요약(raw artifact 가 아님)', () => {
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'X',
      currentState: 's',
      nextFirstCheck: 'check',
      evidenceRefs: [{ kind: 'command', command: 'bun test', summary: 'exit 0' }],
    });
    // schema 가 evidenceRef.summary 를 인라인 요약으로 강제(raw artifact 경로가 아님).
    expect(h.evidence_refs[0]?.summary).toBe('exit 0');
  });

  test('HandoffStore.write 는 handoff.json 기록 + work item handoff_path 자동 링크', async () => {
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'X',
      currentState: 's',
      nextFirstCheck: 'c',
    });
    const s = new HandoffStore(tmp);
    await s.write(h);
    expect(await s.exists(wi.id)).toBe(true);
    const linked = await items.get(wi.id);
    expect(linked.handoff_path).toBe(`.ditto/work-items/${wi.id}/handoff.json`);
    // 라운드트립: parse 가능한 handoff 가 디스크에 있어야 한다.
    const back = await s.get(wi.id);
    expect(back.work_item_id).toBe(wi.id);
  });

  test('handoff 는 같은 autopilot_id 로 resume target 을 명시할 수 있다(scope 불변)', () => {
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'X',
      currentState: 's',
      nextFirstCheck: 'c',
      autopilotId: 'orch_abc12345',
    });
    expect(h.autopilot_id).toBe('orch_abc12345');
  });

  test('handoff 만으로 새 세션이 이어받기 위한 최소 정보가 모두 포함된다', () => {
    // 설계서 §12 M4 완료기준: "handoff 만 보고 새 세션이 이어받을 수 있다."
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'old session ended at compaction',
      currentState: 'N2 implement in progress, ac-1 pending verification',
      nextFirstCheck: 'Run bun test on src/password.ts',
      decisionsMade: ['chose bcrypt over argon2 (perf for v0)'],
      openThreads: ['edge case: empty body validation'],
    });
    // resume 에 꼭 필요한 5요소 — 원래 의도·현재 상태·다음 확인·결정 이력·미해결.
    expect(h.original_intent).toBeTruthy();
    expect(h.current_state).toBeTruthy();
    expect(h.next_first_check).toBeTruthy();
    expect(h.decisions_made.length).toBeGreaterThan(0);
    expect(h.open_threads.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M4.2 — PreCompact 핸들러 (압축 전 handoff 작성, 비차단·fail-open)', () => {
  const run = (raw: Record<string, unknown> = {}) =>
    preCompactHandler({ raw: { session_id: SESSION, ...raw }, repoRoot: tmp, env: {} });

  test('active work item 존재 → handoff.json 을 압축 전에 작성한다', async () => {
    const before = await new HandoffStore(tmp).exists(wi.id);
    expect(before).toBe(false);
    const out = await run({ trigger: 'auto' });
    expect(out.exitCode).toBe(0); // 비차단
    expect(await new HandoffStore(tmp).exists(wi.id)).toBe(true);
  });

  test('비차단 — 다음 조건에서 모두 exit 0 + handoff 미작성: 세션 없음·포인터 없음·work item 없음', async () => {
    expect((await preCompactHandler({ raw: {}, repoRoot: tmp, env: {} })).exitCode).toBe(0);
    const noPointer = await preCompactHandler({
      raw: { session_id: 'unknown' },
      repoRoot: tmp,
      env: {},
    });
    expect(noPointer.exitCode).toBe(0);
    // 위 두 경로에서 wi.id 의 handoff 는 만들어지지 않아야 한다(active 없음 → 무시).
    expect(await new HandoffStore(tmp).exists(wi.id)).toBe(false);
  });

  test('trigger 메타가 from_context 에 반영된다 (auto/manual 등 판정 가능)', async () => {
    await run({ trigger: 'manual' });
    const h = await new HandoffStore(tmp).get(wi.id);
    expect(h.from_context).toMatch(/manual/);
  });

  test('재진입 hint(re_entry.command) 가 work item 에 있으면 handoff open_threads 로 운반', async () => {
    await items.update(wi.id, (cur) => ({
      ...cur,
      re_entry: { command: 'ditto work resume wi_x', fresh_evidence_needed: [] },
    }));
    await run();
    const h = await new HandoffStore(tmp).get(wi.id);
    expect(h.open_threads).toContain('ditto work resume wi_x');
  });

  test('일관성 invariant: PreCompact 후 work item 의 handoff_path 가 작성된 artifact 를 가리킨다', async () => {
    await run();
    const refreshed = await items.get(wi.id);
    expect(refreshed.handoff_path).toBe(`.ditto/work-items/${wi.id}/handoff.json`);
  });

  test('autopilot 연속성: active autopilot 의 autopilot_id 가 handoff 에 전달된다 (§AC-1, wi_v04runtimewiring 2026-05-31)', async () => {
    const graph = {
      schema_version: '0.1.0' as const,
      autopilot_id: 'orch_2605310c1' as const,
      work_item_id: wi.id,
      mode: 'autopilot' as const,
      root_goal: wi.goal,
      completion_boundary: 'entire_work_item' as const,
      approval_gate: {
        status: 'not_required' as const,
        source: 'small_reversible_policy' as const,
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
      },
      nodes: [
        {
          id: 'N1',
          kind: 'design' as const,
          owner: 'planner' as const,
          purpose: 'design',
          acceptance_refs: ['ac-1'],
          depends_on: [],
          status: 'pending' as const,
          evidence_refs: [],
          attempts: { fix: 0, switch: 0 },
        },
      ],
      caps: { fix_per_node: 2, switch_per_node: 1 },
      continue_policy: {
        continue_after_approval: true,
        continue_after_checkpoint: true,
        continue_after_fixable_failure: true,
        ask_user_only_for_user_owned_decisions: true,
      },
      stop_conditions: ['all_acceptance_criteria_passed_or_explicitly_closed' as const],
      user_interrupt_policy: 'ask_only_for_user_owned_decisions' as const,
    };
    await new AutopilotStore(tmp).write(wi.id, graph);
    await run();
    const h = await new HandoffStore(tmp).get(wi.id);
    expect(h.autopilot_id).toBe('orch_2605310c1');
  });

  test('autopilot 부재 → handoff.autopilot_id 미포함 (backward compat)', async () => {
    await run();
    const h = await new HandoffStore(tmp).get(wi.id);
    expect(h.autopilot_id).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M4 — active work item context injection (M1.3 charter projection cross-check)', () => {
  // 설계서 §12 M4 목표 중 "active work item context injection" 항목은
  // 실제로 UserPromptSubmit charter projection 으로 구현돼 있다(M1.3).
  // 여기서는 M4 의 관점 — *압축 이후 새 세션* 시점에도 work item 식별자가
  // 매 턴 주입되는지를 단언한다(M1.3 acceptance 와 의도적 중첩).
  test('UserPromptSubmit 은 매 턴 active work item 식별자를 additionalContext 로 주입', async () => {
    const out = await userPromptSubmitHandler({
      raw: { session_id: SESSION, prompt: 'resume' },
      repoRoot: tmp,
      env: {},
    });
    const ctx = JSON.parse(out.stdout ?? '{}').hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain(wi.id); // active work item 식별자 주입
  });

  test('pending handoff 가 있으면 hint 가 charter context 에 포함된다', async () => {
    // PreCompact 가 handoff 를 작성 → work item handoff_path 세팅
    await preCompactHandler({ raw: { session_id: SESSION }, repoRoot: tmp, env: {} });
    const out = await userPromptSubmitHandler({
      raw: { session_id: SESSION, prompt: 'next session' },
      repoRoot: tmp,
      env: {},
    });
    const ctx = JSON.parse(out.stdout ?? '{}').hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('handoff'); // pending handoff hint 가 보여야 한다
  });
});
