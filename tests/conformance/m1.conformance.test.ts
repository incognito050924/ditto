/**
 * v0 구현 계획 적합성(conformance) 테스트 — Milestone 1 (plugin skeleton + hook 동작).
 * plan §3 의 각 build unit acceptance 를 문서에서 직접 인코딩한다. (목적: 문서대로
 * 구현됐는지 독립 판정 — 편차는 FAIL 로 드러난다.)
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeHostAdapter } from '~/core/hosts';
import { SessionPointerStore } from '~/core/session-pointer';
import { collectSurfaceInventory, generateSurfaceCatalog } from '~/core/surface-inventory';
import { WorkItemStore } from '~/core/work-item-store';
import { type HookHandler, KILL_SWITCH, noOpHandler, runHook } from '~/hooks/runtime';
import { stopHandler } from '~/hooks/stop';
import { resolveActiveWorkItem, userPromptSubmitHandler } from '~/hooks/user-prompt-submit';

const REPO = join(import.meta.dir, '..', '..');
const readText = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ditto-conf-m1-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// 작은 AC 빌더.
const ac = (id: string) => ({
  id,
  statement: `returns ok for ${id}`,
  verdict: 'unverified' as const,
  evidence: [],
});

// ─────────────────────────────────────────────────────────────────────────
describe('M1.1 — plugin.json + 레이아웃', () => {
  // acceptance: plugin.json(name=ditto) 로드, layout 디렉터리 존재.
  test('plugin.json: name=ditto, description/version 존재', () => {
    const pj = JSON.parse(readText('.claude-plugin/plugin.json'));
    expect(pj.name).toBe('ditto');
    expect(typeof pj.description).toBe('string');
    expect(pj.description.length).toBeGreaterThan(0);
    expect(pj.version).toBeDefined();
  });

  test('layout: hooks/ · skills/ · agents/ 디렉터리 존재', () => {
    expect(existsSync(join(REPO, 'hooks'))).toBe(true);
    expect(existsSync(join(REPO, 'skills'))).toBe(true);
    expect(existsSync(join(REPO, 'agents'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M1.2 — hooks.json manifest + fail-open glue', () => {
  // acceptance: v0 표면 4개 등록; hook 크래시는 fail-open(exit 0); 게이트 미충족(exit 2)은 삼키지 않음.
  test('hooks.json 에 v0 표면 4개(UserPromptSubmit/Stop/PreCompact/PostToolUse) 등록', () => {
    const hj = JSON.parse(readText('hooks/hooks.json'));
    for (const ev of ['UserPromptSubmit', 'Stop', 'PreCompact', 'PostToolUse']) {
      expect(hj.hooks[ev], `${ev} not registered`).toBeDefined();
    }
  });

  test('hook 크래시(예외) → fail-open(exit 0)', async () => {
    const crashing: HookHandler = () => {
      throw new Error('boom');
    };
    const out = await runHook(crashing, { raw: {}, repoRoot: tmp, env: {} });
    expect(out.exitCode).toBe(0);
  });

  test('kill-switch(DITTO_SKIP_HOOKS) → 핸들러 미실행, exit 0', async () => {
    let ran = false;
    const handler: HookHandler = () => {
      ran = true;
      return { exitCode: 2 };
    };
    const out = await runHook(handler, { raw: {}, repoRoot: tmp, env: { [KILL_SWITCH]: '1' } });
    expect(out.exitCode).toBe(0);
    expect(ran).toBe(false);
  });

  test('PreCompact/PostToolUse 는 no-op stub (exit 0)', async () => {
    expect((await noOpHandler({ raw: {}, repoRoot: tmp, env: {} })).exitCode).toBe(0);
  });

  test('게이트 판정(exit 2)은 wrapper가 삼키지 않고 그대로 전달 (fail-open ≠ fail-closed)', async () => {
    const gateBlock: HookHandler = () => ({ exitCode: 2, stderr: 'blocked' });
    const out = await runHook(gateBlock, { raw: {}, repoRoot: tmp, env: {} });
    expect(out.exitCode).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M1.3 — UserPromptSubmit hook 최소 동작 (단일 active invariant)', () => {
  const SESSION = 'sess-m13';
  const run = (raw: Record<string, unknown>) =>
    userPromptSubmitHandler({ raw: { session_id: SESSION, ...raw }, repoRoot: tmp, env: {} });

  test('빈 상태 → 자동 생성 안 함, 포인터 unset, work-item 가이드 + charter context 주입', async () => {
    const items = new WorkItemStore(tmp);
    const out = await run({ prompt: 'add a password endpoint' });
    expect(out.exitCode).toBe(0); // advisory: 절대 block 안 함
    // 새 모델(manual-create): 빈 상태에서 work item 도 포인터도 만들지 않는다.
    expect((await items.list()).length, 'must not auto-create a work item').toBe(0);
    expect(await new SessionPointerStore(tmp).get(SESSION), 'pointer must stay unset').toBeNull();
    const ctx = JSON.parse(out.stdout ?? '{}').hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('prime directive'); // charter projection
    expect(ctx).toContain('ditto work start'); // work-item 가이드 발화
  });

  test('기존 포인터 있으면 그 work item 로드(action=loaded)', async () => {
    const items = new WorkItemStore(tmp);
    const created = await items.create({
      title: 'mine',
      source_request: 'first prompt',
      goal: 'first prompt',
      acceptance_criteria: [ac('ac-1')],
    });
    await new SessionPointerStore(tmp).set(SESSION, created.id);
    const again = await resolveActiveWorkItem(tmp, SESSION, 'second prompt');
    expect(again.action).toBe('loaded');
    expect(again.workItem?.id).toBe(created.id);
  });

  test('다중 draft + 포인터 없음 → ask (임의 선택 금지, 신규 생성도 안 함)', async () => {
    const items = new WorkItemStore(tmp);
    await items.create({
      title: 'a',
      source_request: 'a',
      goal: 'a',
      acceptance_criteria: [ac('ac-1')],
    });
    await items.create({
      title: 'b',
      source_request: 'b',
      goal: 'b',
      acceptance_criteria: [ac('ac-1')],
    });
    const before = (await items.list()).length;
    const resolved = await resolveActiveWorkItem(tmp, 'fresh-session', 'ambiguous');
    expect(resolved.action).toBe('ask');
    expect(resolved.advisory).toBeDefined();
    expect(resolved.workItem).toBeUndefined();
    expect((await items.list()).length, 'must not create a new work item').toBe(before);
  });

  test('다중 draft + 포인터 존재 → 포인터가 가리키는 단 1개만 active', async () => {
    const items = new WorkItemStore(tmp);
    const a = await items.create({
      title: 'a',
      source_request: 'a',
      goal: 'a',
      acceptance_criteria: [ac('ac-1')],
    });
    await items.create({
      title: 'b',
      source_request: 'b',
      goal: 'b',
      acceptance_criteria: [ac('ac-1')],
    });
    await new SessionPointerStore(tmp).set('s-multi', a.id);
    const resolved = await resolveActiveWorkItem(tmp, 's-multi', 'go');
    expect(resolved.action).toBe('loaded');
    expect(resolved.workItem?.id).toBe(a.id);
  });

  test('Stop 이 UserPromptSubmit 과 같은 포인터로 같은 work item 을 본다', async () => {
    await run({ prompt: 'shared pointer check' });
    const upsPointer = await new SessionPointerStore(tmp).get(SESSION);
    // Stop 핸들러도 동일 SessionPointerStore 를 읽는다 → 같은 work item.
    const stopPointer = await new SessionPointerStore(tmp).get(SESSION);
    expect(stopPointer).toBe(upsPointer);
  });

  test('로드된 placeholder-only work item → placeholder advisory inject (§AC-3, wi_v04runtimewiring 2026-05-31)', async () => {
    // 새 모델(manual-create): 자동 생성은 더 이상 없다. placeholder-only WI 는
    // `work start` 등으로 명시 생성되어 포인터로 로드된 상태에서 advisory 가 발화한다.
    const items = new WorkItemStore(tmp);
    const created = await items.create({
      title: 'ph',
      source_request: 'do something',
      goal: 'do something',
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 'TBD — derive observable criteria during interview/planning',
          verdict: 'unverified',
          evidence: [],
        },
      ],
    });
    await new SessionPointerStore(tmp).set('s-ph', created.id);
    const out = await userPromptSubmitHandler({
      raw: { session_id: 's-ph', prompt: 'do something' },
      repoRoot: tmp,
      env: {},
    });
    const ctx = JSON.parse(out.stdout ?? '{}').hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('acceptance criteria가 아직 자리표시자다'); // reworded to Korean (wi_260713nlg)
    expect(ctx).toContain('/ditto:deep-interview');
  });

  test('real AC가 있는 work item → placeholder advisory 미발화 (false-positive 차단)', async () => {
    const items = new WorkItemStore(tmp);
    const created = await items.create({
      title: 'real',
      source_request: 'r',
      goal: 'r',
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: '/health endpoint returns 200',
          verdict: 'unverified',
          evidence: [],
        },
      ],
    });
    await new SessionPointerStore(tmp).set('s-real', created.id);
    const out = await userPromptSubmitHandler({
      raw: { session_id: 's-real', prompt: 'continue' },
      repoRoot: tmp,
      env: {},
    });
    const ctx = JSON.parse(out.stdout ?? '{}').hookSpecificOutput.additionalContext as string;
    expect(ctx).not.toContain('acceptance criteria가 아직 자리표시자다'); // reworded to Korean (wi_260713nlg)
  });

  // 새 모델(manual-create): 자동 생성이 없으므로 directive 는 *로드된* placeholder-only
  // work item 에서만 발화한다. 명시 생성된 placeholder-only WI 를 포인터로 로드해서 검증.
  const seedPlaceholderOnly = async (sessionId: string): Promise<void> => {
    const items = new WorkItemStore(tmp);
    const created = await items.create({
      title: 'ph',
      source_request: 'r',
      goal: 'r',
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 'TBD — derive observable criteria during interview/planning',
          verdict: 'unverified',
          evidence: [],
        },
      ],
    });
    await new SessionPointerStore(tmp).set(sessionId, created.id);
  };
  const runWith = (sessionId: string, prompt: string) =>
    userPromptSubmitHandler({ raw: { session_id: sessionId, prompt }, repoRoot: tmp, env: {} });

  test('placeholder-only + execution prompt → deep-interview directive inject (§AC-1, wi_v04intent_autopilot_entry 2026-06-01)', async () => {
    // Loaded placeholder-only work item (e.g. from `work start`); execution-shape prompt.
    await seedPlaceholderOnly('s-dir');
    const out = await runWith('s-dir', 'build the password endpoint');
    const ctx = JSON.parse(out.stdout ?? '{}').hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('지금 /ditto:deep-interview를 실행하라'); // reworded to Korean (wi_260713nlg)
    expect(ctx).toContain('가벼운 경로'); // light-path fallback still surfaced (internal name anchor dropped, wi_260713nlg iter)
  });

  test('placeholder-only + question prompt → directive NOT injected (보수성)', async () => {
    await seedPlaceholderOnly('s-dir-q');
    const out = await runWith('s-dir-q', 'what does the bridge command do?');
    const ctx = JSON.parse(out.stdout ?? '{}').hookSpecificOutput.additionalContext as string;
    expect(ctx).not.toContain('지금 /ditto:deep-interview를 실행하라'); // reworded to Korean (wi_260713nlg)
  });

  test('question + codebase-locatable prompt → QuestionGate self-answer hint (§AC-5, wi_v04intent_autopilot_entry 2026-06-01)', async () => {
    const out = await run({
      prompt: 'what does the function handleRequest in src/api.ts do?',
    });
    const ctx = JSON.parse(out.stdout ?? '{}').hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('코드·문서·웹에서 먼저 스스로 답하라'); // reworded to Korean (wi_260713nlg)
    expect(ctx).toContain('사용자 입력 없이도 답할 수 있어'); // self-answer cue (internal name anchor dropped, wi_260713nlg iter)
  });

  test('question without codebase mention → no QuestionGate hint (false-positive 차단)', async () => {
    const out = await run({ prompt: 'what should we name it?' });
    const ctx = JSON.parse(out.stdout ?? '{}').hookSpecificOutput.additionalContext as string;
    expect(ctx).not.toContain('코드·문서·웹에서 먼저 스스로 답하라'); // reworded to Korean (wi_260713nlg)
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M1.4 — Stop hook 최소 동작 (완료/수렴/노드상태 게이트)', () => {
  const SESSION = 'sess-m14';
  let wiId: string;
  let dir: string;
  beforeEach(async () => {
    const store = new WorkItemStore(tmp);
    const created = await store.create({
      title: 't',
      source_request: 'r',
      goal: 'g',
      acceptance_criteria: [ac('ac-1'), ac('ac-2')],
    });
    wiId = created.id;
    dir = join(tmp, '.ditto', 'local', 'work-items', wiId);
    await new SessionPointerStore(tmp).set(SESSION, wiId);
  });
  const run = (raw: Record<string, unknown> = {}) =>
    stopHandler({ raw: { session_id: SESSION, ...raw }, repoRoot: tmp, env: {} });
  const write = (name: string, obj: unknown) =>
    writeFile(join(dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj));

  const completion = (over: Record<string, unknown>) => ({
    schema_version: '0.1.0',
    work_item_id: wiId,
    declared_by: 'main',
    declared_at: '2026-05-26T02:00:00.000Z',
    summary: 's',
    changed_files: [],
    verifications: [{ command: 'bun test', exit_code: 0 }],
    unverified: [],
    remaining_risks: [],
    final_verdict: 'pass',
    ...over,
  });
  const pilot = (over: Record<string, unknown>) => ({
    schema_version: '0.1.0',
    autopilot_id: 'orch_conf0001',
    work_item_id: wiId,
    mode: 'autopilot',
    root_goal: 'g',
    completion_boundary: 'entire_work_item',
    approval_gate: {
      status: 'not_required',
      source: null,
      approved_at: null,
      approved_by: null,
      evidence_refs: [],
    },
    nodes: [],
    caps: { fix_per_node: 2, switch_per_node: 1 },
    continue_policy: {},
    stop_conditions: [],
    ...over,
  });
  const node = (over: Record<string, unknown>) => ({
    id: 'N1',
    kind: 'implement',
    owner: 'implementer',
    purpose: 'p',
    status: 'pending',
    depends_on: [],
    acceptance_refs: [],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
    ...over,
  });

  test('미검증 완료(final_verdict=pass 인데 AC 누락) → exit 2 (continue 강제)', async () => {
    await write(
      'completion.json',
      completion({ acceptance: [{ criterion_id: 'ac-1', verdict: 'pass' }] }),
    );
    expect((await run()).exitCode).toBe(2);
  });

  test('완료(모든 AC pass, 집합 일치) → exit 0', async () => {
    await write(
      'completion.json',
      completion({
        acceptance: [
          { criterion_id: 'ac-1', verdict: 'pass' },
          { criterion_id: 'ac-2', verdict: 'pass' },
        ],
      }),
    );
    expect((await run()).exitCode).toBe(0);
  });

  test('완료 artifact 부재 + autopilot ready 노드 존재 → exit 2', async () => {
    await write('autopilot.json', pilot({ nodes: [node({ status: 'pending' })] }));
    expect((await run()).exitCode).toBe(2);
  });

  test('완료 artifact 부재 + active autopilot 없음 + NON_TERMINAL → exit 2 (§M1.4 strong-block 2026-05-31)', async () => {
    // Default work item from beforeEach is status=draft → NON_TERMINAL.
    // plan §M1.4 line 117 originally specified exit 0 here; that was a stub
    // outcome carrying over to v0 closure as the "verify 안 한 채 그냥 종료"
    // gap surfaced in the 2026-05-31 outcome matrix. Strong-block update
    // closes it: NON_TERMINAL work item + all three ledgers absent → exit 2.
    const out = await run();
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('no completion.json');
  });

  test('완료 artifact 부재 + active autopilot 없음 + terminal(done) → exit 0', async () => {
    const store = new WorkItemStore(tmp);
    await store.update(wiId, (current) => ({ ...current, status: 'in_progress' }));
    await store.update(wiId, (current) => ({
      ...current,
      status: 'done',
      closed_at: '2026-05-31T00:00:00.000Z',
    }));
    expect((await run()).exitCode).toBe(0);
  });

  test('approval_gate=pending 루틴 punt → exit 2 force-continue (ac-1, wi_260707loq)', async () => {
    // plan §M1.4 originally yielded exit 0 here ("plan 제시에 양보"): ANY pending
    // approval_gate + a remaining node stopped so the plan could surface. wi_260707loq
    // superseded that broad early-yield with the ordered P1-P6 Stop classifier. This
    // fixture is a BARE routine pending — create() declares no risk, ac() assigns no
    // oracle, and no decision-conflict.json / direction-fork.json carrier is present —
    // so it is a P6 procedure-punt that FORCE-continues (exit 2) rather than stalling
    // forever on a pending nobody approves. A GENUINE decision pending still yields exit
    // 0 (P1 direction-fork / P2 intent-conflict / P3 high-risk / P4 oracle-gap); those
    // yield paths are exercised in the Stop-hook suite (tests/hooks/stop.test.ts), not
    // this bare-fixture conformance case.
    await write(
      'autopilot.json',
      pilot({
        approval_gate: {
          status: 'pending',
          source: null,
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
        },
        nodes: [node({ status: 'pending' })],
      }),
    );
    expect((await run()).exitCode).toBe(2);
  });

  test('blocked 노드만 남음(external/user-owned 양보) → exit 0', async () => {
    // 실행 가능한 노드가 없으면 continuation 강제 안 함 (plan M1.4 (나) 예외 — 양보).
    await write('autopilot.json', pilot({ nodes: [node({ status: 'blocked' })] }));
    expect((await run()).exitCode).toBe(0);
  });

  test('malformed completion.json → exit 2 (게이트 입력 위반은 fail-open 아님)', async () => {
    await write('completion.json', '{ not valid json');
    expect((await run()).exitCode).toBe(2);
  });

  test('malformed autopilot.json → exit 2', async () => {
    await write('autopilot.json', '{ nope');
    expect((await run()).exitCode).toBe(2);
  });

  test('stop_hook_active=true → 즉시 exit 0 (무한루프 가드)', async () => {
    await write('autopilot.json', pilot({ nodes: [node({ status: 'pending' })] }));
    expect((await run({ stop_hook_active: true })).exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M1.5 — skill skeleton 6 표면 + 노출 정책', () => {
  // acceptance: 노출 4종(deep-interview/verify/handoff/dialectic) + dialectic-review alias +
  //             비노출 1종(autopilot, user-invocable:false, disable-model-invocation 미사용).
  const front = (name: string): string => {
    const text = readText(`skills/${name}/SKILL.md`);
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    return m?.[1] ?? '';
  };

  test('v0 skill 6 표면 SKILL.md 전부 존재', () => {
    for (const s of [
      'deep-interview',
      'verify',
      'handoff',
      'dialectic',
      'dialectic-review',
      'autopilot',
    ]) {
      expect(existsSync(join(REPO, 'skills', s, 'SKILL.md')), `${s}/SKILL.md missing`).toBe(true);
    }
  });

  test('비노출 autopilot: user-invocable:false 강제, disable-model-invocation 미사용', () => {
    for (const s of ['autopilot']) {
      const f = front(s);
      expect(f, `${s} must be user-invocable:false`).toMatch(/user-invocable:\s*false/);
      expect(f, `${s} must NOT disable model invocation (내부 호출 경로 보존)`).not.toMatch(
        /disable-model-invocation/,
      );
    }
  });

  test('노출 4종: user-invocable:false 없음(기본=노출)', () => {
    for (const s of ['deep-interview', 'verify', 'handoff', 'dialectic']) {
      expect(front(s), `${s} should be exposed`).not.toMatch(/user-invocable:\s*false/);
    }
  });

  test('dialectic-review 는 dialectic --mode review 로 라우팅', () => {
    const body = readText('skills/dialectic-review/SKILL.md');
    expect(body).toMatch(/dialectic/);
    expect(body).toMatch(/--mode review|mode review|mode=review/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M1.5b — agent skeleton (v0 8종, post-v0 부재)', () => {
  // acceptance: owner 5 + dialectic 3 = 8 agents; orchestrator 파일 없음; post-v0 agent 부재.
  const V0_AGENTS = [
    'researcher',
    'planner',
    'implementer',
    'reviewer',
    'verifier',
    'dialectic-producer',
    'dialectic-opponent',
    'dialectic-synthesizer',
  ];

  test('v0 agent 8종 .md 존재 + frontmatter(name·description·tools)', () => {
    for (const a of V0_AGENTS) {
      const p = join(REPO, 'agents', `${a}.md`);
      expect(existsSync(p), `agents/${a}.md missing`).toBe(true);
      const text = readFileSync(p, 'utf8');
      const m = text.match(/^---\n([\s\S]*?)\n---/);
      const f = m ? m[1] : '';
      expect(f, `${a} frontmatter name`).toMatch(/name:\s*\S/);
      expect(f, `${a} frontmatter description`).toMatch(/description:\s*\S/);
      expect(f, `${a} frontmatter tools`).toMatch(/tools:\s*\S/);
    }
  });

  test('orchestrator 는 main role → agent 파일 없음 (D3)', () => {
    expect(existsSync(join(REPO, 'agents', 'orchestrator.md'))).toBe(false);
  });

  test('playwright-e2e agent .md 존재 + frontmatter (M5 runtime)', () => {
    const p = join(REPO, 'agents', 'playwright-e2e.md');
    expect(existsSync(p), 'agents/playwright-e2e.md missing').toBe(true);
    const text = readFileSync(p, 'utf8');
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    const f = m ? m[1] : '';
    expect(f, 'playwright-e2e frontmatter name').toMatch(/name:\s*\S/);
    expect(f, 'playwright-e2e frontmatter description').toMatch(/description:\s*\S/);
    expect(f, 'playwright-e2e frontmatter tools').toMatch(/tools:\s*\S/);
    // body covers the §3 responsibilities (browser/artifact/reproduction)
    expect(text).toMatch(/Playwright\/Chromium/);
  });

  test('knowledge-curator agent .md 존재 + frontmatter (M6 runtime)', () => {
    const p = join(REPO, 'agents', 'knowledge-curator.md');
    expect(existsSync(p), 'agents/knowledge-curator.md missing').toBe(true);
    const text = readFileSync(p, 'utf8');
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    const f = m ? m[1] : '';
    expect(f, 'knowledge-curator frontmatter name').toMatch(/name:\s*\S/);
    expect(f, 'knowledge-curator frontmatter description').toMatch(/description:\s*\S/);
    expect(f, 'knowledge-curator frontmatter tools').toMatch(/tools:\s*\S/);
    // body covers the §3 responsibilities (glossary / ADR)
    expect(text).toMatch(/glossary/);
    expect(text).toMatch(/ADR/);
  });

  test('post-v0 agent(architect) 는 부재 (M5 미도달)', () => {
    expect(
      existsSync(join(REPO, 'agents', 'architect.md')),
      'architect.md should not exist yet',
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M1.6 — surface inventory 테스트 (drift·false-green 차단)', () => {
  // acceptance: drift 감지(누락/잉여 fail), hook+plugin 포함, 부재·빈 목록 → fail.
  // Code-self-contained (wi_260715ujg): 실 plugin-root 스캔을 커밋된 count 앵커와 대조한다.
  // gitignored per-developer .ditto/local/surfaces.json 부재로 게이트가 flake 하지 않게 —
  // 하드코딩 49 가 앵커라 skill/agent/hook 추가·삭제 시 스캔 개수가 바뀌어 RED. 드리프트
  // 검출 자체(누락/잉여 fail)는 아래 tmp-fixture 케이스가 그대로 exercise 한다.
  test('실제 plugin-root 코드 스캔이 고정된 surface 개수를 낸다 (추가·삭제 → RED)', async () => {
    const cat = await generateSurfaceCatalog([claudeCodeHostAdapter], REPO);
    expect(cat.surfaces.length).toBe(49);
  });

  test('catalog 에 hook · plugin surface 포함 (skill/agent만이 아님)', async () => {
    const cat = await generateSurfaceCatalog([claudeCodeHostAdapter], REPO);
    const kinds = new Set(cat.surfaces.map((s) => s.kind));
    expect(kinds.has('hook')).toBe(true);
    expect(kinds.has('plugin')).toBe(true);
  });

  const writeCatalog = async (obj: unknown) => {
    await mkdir(join(tmp, '.ditto', 'local'), { recursive: true });
    await writeFile(join(tmp, '.ditto', 'local', 'surfaces.json'), JSON.stringify(obj));
  };

  test('선언 surface 가 디스크에 없으면 missing drift 로 보고', async () => {
    await writeCatalog({
      schema_version: '0.1.0',
      surfaces: [
        { host: 'claude-code', kind: 'skill', id: 'ghost', path: 'skills/ghost/SKILL.md' },
      ],
    });
    const report = await collectSurfaceInventory([claudeCodeHostAdapter], tmp);
    expect(report.mismatch_count).toBeGreaterThan(0);
    expect(report.findings[0]?.mismatch).toBe('missing_file');
  });

  test('present-but-empty catalog → throw (false-green 차단)', async () => {
    await writeCatalog({ schema_version: '0.1.0', surfaces: [] });
    let threw = false;
    try {
      await collectSurfaceInventory([claudeCodeHostAdapter], tmp);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('[plan 요구] 부재 catalog → fail 이어야 한다 (통과 금지)', async () => {
    // plan §3 M1.6 acceptance: ".ditto/local/surfaces.json 부재·빈 목록 → fail".
    // 빈 목록은 throw 로 fail 하지만, *부재*도 fail 이어야 한다는 것이 문서 요구.
    // 구현이 부재를 mismatch 0(통과)으로 처리하면 이 테스트가 편차를 드러낸다.
    await mkdir(join(tmp, '.ditto'), { recursive: true });
    let failed = false;
    try {
      const report = await collectSurfaceInventory([claudeCodeHostAdapter], tmp);
      failed = report.mismatch_count > 0; // 통과(mismatch 0)면 문서 요구 미충족
    } catch {
      failed = true; // throw 도 fail 로 인정
    }
    expect(failed, 'absent catalog must be treated as failure per plan M1.6').toBe(true);
  });
});
