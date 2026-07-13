/**
 * v0 구현 계획 적합성(conformance) 테스트 — Milestone 3 (Evidence·verifier 런타임).
 *
 * 권위 출처:
 *  - reports/design/ditto-v0-implementation-plan.md §5 (M3 한 줄 요약)
 *  - reports/design/ditto-claude-code-harness-design.md §12 Milestone 3
 *  - feat(M3) 커밋 메시지(44d8f2c)의 sub-unit 분해(M3.1/M3.2/M3.3)
 *
 * 검증 원칙: 결정론 런타임만 단언 (LLM 판단부 — verifier 실행, admissibility 결정 —
 * 는 skill/agent 본문이라 단위 검증 대상 아님; 입력으로 들어온 결과의 *결정론적
 * 조립/재계산*만 본다). M0.4 게이트를 통과하는 산출을 produce 해야 한다.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompletionStore, buildCompletion } from '~/core/completion-store';
import { ConvergenceStore, buildConvergence } from '~/core/convergence-store';
import { EvidenceStore } from '~/core/evidence-store';
import { completionGate, convergenceGate } from '~/core/gates';
import {
  NoOpponentAvailableError,
  resolveOpponentCandidates,
  selectOpponent,
} from '~/core/opponent-router';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { postToolUseHandler } from '~/hooks/post-tool-use';
import { dialecticForcesContinuation, stopHandler } from '~/hooks/stop';
import { completionContract } from '~/schemas/completion-contract';
import type { DecisionLedgerEntry } from '~/schemas/convergence';
import { type Dialectic, dialectic as dialecticSchema } from '~/schemas/dialectic';
import { commandLogEntry } from '~/schemas/evidence-log';
import { evidenceRecord } from '~/schemas/evidence-record';
import type { WorkItem } from '~/schemas/work-item';

let tmp: string;
let store: WorkItemStore;
let wi: WorkItem;
const SESSION = 'sess-m3';
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ditto-conf-m3-'));
  store = new WorkItemStore(tmp);
  wi = await store.create({
    title: 'pw endpoint',
    source_request: 'add endpoint',
    goal: 'endpoint returns score',
    acceptance_criteria: [
      { id: 'AC-1', statement: 'returns 200', verdict: 'unverified', evidence: [] },
      { id: 'AC-2', statement: 'rejects empty', verdict: 'unverified', evidence: [] },
    ],
  });
  await new SessionPointerStore(tmp).set(SESSION, wi.id);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const commandsPath = () =>
  join(tmp, '.ditto', 'local', 'work-items', wi.id, 'evidence', 'commands.jsonl');

const readLog = async () => {
  const text = await readFile(commandsPath(), 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
};

// ─────────────────────────────────────────────────────────────────────────
describe('M3.1 — PostToolUse evidence (테스트/빌드/브라우저 명령 결과를 evidence 로 남김)', () => {
  const run = (raw: Record<string, unknown>) =>
    postToolUseHandler({ raw: { session_id: SESSION, ...raw }, repoRoot: tmp, env: {} });

  test('Bash 실행 → commands.jsonl 에 commandLogEntry 한 줄 append', async () => {
    const out = await run({
      tool_name: 'Bash',
      tool_input: { command: 'bun test' },
      tool_response: { exit_code: 0 },
    });
    expect(out.exitCode).toBe(0);
    const log = await readLog();
    expect(log.length).toBe(1);
    // Schema 검증: 저장된 라인은 commandLogEntry 로 parse 통과해야 한다.
    expect(commandLogEntry.safeParse(log[0]).success).toBe(true);
    expect(log[0].command).toBe('bun test');
    expect(log[0].exit_code).toBe(0);
    expect(log[0].work_item_id).toBe(wi.id);
  });

  test('best-effort exit code: exit_code / exitCode / is_error 모든 형태 처리', async () => {
    await run({ tool_name: 'Bash', tool_input: { command: 'a' }, tool_response: { exit_code: 7 } });
    await run({ tool_name: 'Bash', tool_input: { command: 'b' }, tool_response: { exitCode: 3 } });
    await run({
      tool_name: 'Bash',
      tool_input: { command: 'c' },
      tool_response: { is_error: true },
    });
    const log = await readLog();
    expect(log.map((e) => e.exit_code)).toEqual([7, 3, 1]);
  });

  test('비차단 — 다음 조건에서 절대 block 안 함(항상 exit 0): Bash 아닌 도구·세션 없음·포인터 없음', async () => {
    expect((await run({ tool_name: 'Edit', tool_input: {}, tool_response: {} })).exitCode).toBe(0);
    expect(
      (
        await postToolUseHandler({
          raw: { tool_name: 'Bash', tool_input: { command: 'x' } },
          repoRoot: tmp,
          env: {},
        })
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await postToolUseHandler({
          raw: { session_id: 'unknown-sess', tool_name: 'Bash', tool_input: { command: 'x' } },
          repoRoot: tmp,
          env: {},
        })
      ).exitCode,
    ).toBe(0);
  });

  test('포인터 없는 세션 → evidence 파일을 만들지 않는다(active work item 없음)', async () => {
    await postToolUseHandler({
      raw: {
        session_id: 'no-pointer',
        tool_name: 'Bash',
        tool_input: { command: 'x' },
        tool_response: {},
      },
      repoRoot: tmp,
      env: {},
    });
    expect(await Bun.file(commandsPath()).exists()).toBe(false);
  });

  test('append-only: 여러 호출이 라인을 추가하고 순서를 보존한다', async () => {
    for (const cmd of ['one', 'two', 'three']) {
      await run({
        tool_name: 'Bash',
        tool_input: { command: cmd },
        tool_response: { exit_code: 0 },
      });
    }
    const log = await readLog();
    expect(log.map((e) => e.command)).toEqual(['one', 'two', 'three']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M3.2 — completion 빌더/store (verifier 판정 → 결정론 조립, completionGate 통과물)', () => {
  // 설계서 §12 M3 완료기준: "verifier가 acceptance criteria별 pass/fail/unverified를 기록한다."
  test('work item AC당 정확히 1 entry — 집합 정합 보장 (completionGate 누락/잉여/중복 회피)', () => {
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'all green',
      verdicts: [
        { criterion_id: 'AC-1', verdict: 'pass' },
        { criterion_id: 'AC-2', verdict: 'pass' },
      ],
    });
    const ids = completion.acceptance.map((a) => a.criterion_id);
    expect(ids).toEqual(['AC-1', 'AC-2']);
    expect(new Set(ids).size).toBe(ids.length); // duplicate 없음
    // M0.4 cross-check: completionGate 가 PASS 여야 한다(빌더의 첫째 의무).
    expect(completionGate(wi, completion).pass).toBe(true);
  });

  test('verifier 가 기록하지 않은 criterion → unverified 로 채움 (결정론적 default)', () => {
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'partial',
      verdicts: [{ criterion_id: 'AC-1', verdict: 'pass' }],
    });
    const ac2 = completion.acceptance.find((a) => a.criterion_id === 'AC-2');
    expect(ac2?.verdict).toBe('unverified');
  });

  test('final_verdict 도출: 모든 pass + in-scope unverified 0 → pass, fail 하나라도 → fail', () => {
    const allPass = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 's',
      verdicts: [
        { criterion_id: 'AC-1', verdict: 'pass' },
        { criterion_id: 'AC-2', verdict: 'pass' },
      ],
    });
    expect(allPass.final_verdict).toBe('pass');

    const oneFail = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 's',
      verdicts: [
        { criterion_id: 'AC-1', verdict: 'fail' },
        { criterion_id: 'AC-2', verdict: 'pass' },
      ],
    });
    expect(oneFail.final_verdict).toBe('fail');
  });

  test('in-scope unverified 가 남으면 final_verdict 는 pass 가 아니다', () => {
    const result = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 's',
      verdicts: [
        { criterion_id: 'AC-1', verdict: 'pass' },
        { criterion_id: 'AC-2', verdict: 'pass' },
      ],
      unverified: [{ item: 'edge case', reason: 'no test infra', out_of_scope: false }],
    });
    expect(result.final_verdict).not.toBe('pass');
  });

  test('CompletionStore: write → exists → get 라운드트립', async () => {
    const c = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 's',
      verdicts: [
        { criterion_id: 'AC-1', verdict: 'pass' },
        { criterion_id: 'AC-2', verdict: 'pass' },
      ],
    });
    const s = new CompletionStore(tmp);
    await s.write(c);
    expect(await s.exists(wi.id)).toBe(true);
    const back = await s.get(wi.id);
    expect(back.final_verdict).toBe('pass');
    expect(back.acceptance.map((a) => a.criterion_id)).toEqual(['AC-1', 'AC-2']);
  });

  // 설계서 line 700 "판정 주체(verifier)": declared_by 는 판정한 *역할*이지 실행 프로파일이 아니다.
  test('declared_by=verifier 인 completion 은 CONFORMS (판정 주체가 verifier)', () => {
    const c = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'verifier가 직접 검증해 박은 판정',
      verdicts: [
        { criterion_id: 'AC-1', verdict: 'pass' },
        { criterion_id: 'AC-2', verdict: 'pass' },
      ],
    });
    expect(c.declared_by).toBe('verifier');
    // 빌더 산출이 schema 를 통과 (declarerRole enum 정합)
    expect(() => completionContract.parse(c)).not.toThrow();
  });

  test('declared_by 에 실행 프로파일/비역할 문자열을 박으면 schema reject (사칭 차단)', () => {
    const valid = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 's',
      verdicts: [
        { criterion_id: 'AC-1', verdict: 'pass' },
        { criterion_id: 'AC-2', verdict: 'pass' },
      ],
    });
    // 실행 프로파일 값(owner_profile 류)은 declarer 가 아니다 → reject
    for (const impostor of ['workspace-write', 'read-only', 'networked', 'isolated', '', 'v']) {
      expect(
        () => completionContract.parse({ ...valid, declared_by: impostor }),
        `declared_by="${impostor}" must be rejected`,
      ).toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M3.3 — convergence 빌더/store (admissibility 입력, 결정론 재계산, ratchet)', () => {
  // 설계서 §12 M3 완료기준: "반복 정련이 두 게이트(완료↔수렴)로 종료되고,
  //                         캡 도달은 non-pass로 닫힌다."
  const ledger = (overrides: Partial<DecisionLedgerEntry>): DecisionLedgerEntry => ({
    id: 'OBJ-1',
    round: 1,
    objection: 'objection text',
    kind: 'hypothesis',
    criterion_id: null,
    // admissible=true requires high/critical severity (ADMISSIBLE_SEVERITIES);
    // the prior 'medium' default contradicted that and is now schema-rejected.
    severity: 'high',
    admissible: true,
    status: 'deferred',
    confidence: 'medium',
    backed_by: [],
    reason: 'r',
    supersedes: null,
    ...overrides,
  });

  test('argmax 선택: selected_version 은 최고 score 의 version (ratchet — 최선본 보존)', () => {
    const c = buildConvergence({
      workItemId: wi.id,
      targetRef: 'AC-set',
      roundCap: 3,
      roundsRun: 2,
      versions: [
        { version: 1, score: 0.7, evidence_refs: [] },
        { version: 2, score: 0.9, evidence_refs: [] },
        { version: 3, score: 0.8, evidence_refs: [] },
      ],
      ledger: [],
      completionGateVerdict: 'pass',
    });
    expect(c.selected_version).toBe(2);
  });

  test('open_admissible_count = ledger 의 (admissible ∧ status=deferred) 수', () => {
    const c = buildConvergence({
      workItemId: wi.id,
      targetRef: 'AC-set',
      roundCap: 3,
      roundsRun: 1,
      versions: [{ version: 1, score: 0.8, evidence_refs: [] }],
      ledger: [
        ledger({ id: 'A', admissible: true, status: 'deferred' }),
        ledger({ id: 'B', admissible: true, status: 'acted' }),
        ledger({ id: 'C', admissible: false, status: 'deferred' }),
      ],
      completionGateVerdict: 'partial',
    });
    expect(c.open_admissible_count).toBe(1);
  });

  test('converged = completion_gate=pass ∧ open_admissible=0 (두 게이트 결합)', () => {
    const converged = buildConvergence({
      workItemId: wi.id,
      targetRef: 'AC-set',
      roundCap: 3,
      roundsRun: 1,
      versions: [{ version: 1, score: 0.9, evidence_refs: [] }],
      ledger: [],
      completionGateVerdict: 'pass',
    });
    expect(converged.gate.converged).toBe(true);
    expect(converged.exit.reason).toBe('converged');

    const open = buildConvergence({
      workItemId: wi.id,
      targetRef: 'AC-set',
      roundCap: 3,
      roundsRun: 1,
      versions: [{ version: 1, score: 0.9, evidence_refs: [] }],
      ledger: [ledger({ admissible: true, status: 'deferred' })],
      completionGateVerdict: 'pass',
    });
    expect(open.gate.converged).toBe(false);
  });

  test('캡 도달 → exit.reason=cap_reached, converged=false (non-pass 로 닫힘)', () => {
    const c = buildConvergence({
      workItemId: wi.id,
      targetRef: 'AC-set',
      roundCap: 2,
      roundsRun: 2,
      versions: [{ version: 1, score: 0.5, evidence_refs: [] }],
      ledger: [],
      completionGateVerdict: 'partial',
    });
    expect(c.gate.converged).toBe(false);
    expect(c.exit.reason).toBe('cap_reached');
    // non-converged → handoff path 가 채워져야 한다(§5 cap_reached/blocked 처리).
    expect(c.exit.next_handoff_path).not.toBeNull();
  });

  test('빌더 산출은 M0.4 convergenceGate 를 통과 (수렴 시)', () => {
    const c = buildConvergence({
      workItemId: wi.id,
      targetRef: 'AC-set',
      roundCap: 3,
      roundsRun: 1,
      versions: [
        { version: 1, score: 0.7, evidence_refs: [] },
        { version: 2, score: 0.95, evidence_refs: [] },
      ],
      ledger: [
        ledger({
          id: 'X',
          admissible: true,
          status: 'acted',
          backed_by: [{ kind: 'command', command: 't', summary: 'ok' }],
          kind: 'finding',
        }),
      ],
      completionGateVerdict: 'pass',
    });
    expect(convergenceGate(c).pass).toBe(true);
  });

  test('admissibility 는 *입력*이고 *판정* 아님 — 같은 ledger 에 admissible flag 만 바꿔도 빌더 결과가 따른다', () => {
    const base = {
      workItemId: wi.id,
      targetRef: 'AC-set',
      roundCap: 3,
      roundsRun: 1,
      versions: [{ version: 1, score: 0.9, evidence_refs: [] }],
      completionGateVerdict: 'pass' as const,
    };
    const withAdmissible = buildConvergence({
      ...base,
      ledger: [ledger({ admissible: true, status: 'deferred' })],
    });
    const withDismissed = buildConvergence({
      ...base,
      ledger: [ledger({ admissible: false, status: 'deferred' })],
    });
    expect(withAdmissible.open_admissible_count).toBe(1);
    expect(withDismissed.open_admissible_count).toBe(0);
    // 빌더는 admissibility 를 *결정*하지 않고 *기록된 값으로* 카운트만 한다.
  });

  test('append-only ratchet: appendLedgerEntry 가 새 entry 만 추가하고 gate 를 재계산 (in-place edit 아님)', async () => {
    const s = new ConvergenceStore(tmp);
    const initial = buildConvergence({
      workItemId: wi.id,
      targetRef: 'AC-set',
      roundCap: 3,
      roundsRun: 1,
      versions: [{ version: 1, score: 0.8, evidence_refs: [] }],
      ledger: [],
      completionGateVerdict: 'pass',
    });
    await s.write(initial);
    const updated = await s.appendLedgerEntry(
      wi.id,
      ledger({ id: 'NEW', admissible: true, status: 'deferred' }),
    );
    // 기존 entry 유지 + 새 entry 추가 (length += 1).
    expect(updated.decision_ledger.length).toBe(initial.decision_ledger.length + 1);
    // gate 재계산: 새 admissible deferred 가 추가됐으므로 converged false 로 바뀐다.
    expect(updated.gate.converged).toBe(false);
    expect(updated.open_admissible_count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M3.4 — EvidenceRecord sidecar + evidence-index.json ledger (freshness·portability)', () => {
  // 설계서 §6.7 line 633-645: "증거가 있다" 와 "이 clone/세션에서 raw 를 열 수 있다" 를
  // freshness/portability/artifact_available 로 분리. raw 없이도 summary/sha/exit_code 로 판정.
  const fresh = (over: Record<string, unknown> = {}) => ({
    ref: { kind: 'command' as const, command: 'bun test', summary: 'passed' },
    captured_at: '2026-05-26T00:00:00.000Z',
    freshness: 'fresh' as const,
    portability: 'committed' as const,
    artifact_available: true,
    exit_code: 0,
    ...over,
  });

  test('유효 레코드: fresh+committed+available 는 CONFORMS, default(stale_reason null·key_lines []) 적용', () => {
    const r = evidenceRecord.parse(fresh());
    expect(r.stale_reason).toBe(null);
    expect(r.key_lines).toEqual([]);
  });

  test('cross-field (a): freshness=stale 인데 stale_reason 없으면 reject', () => {
    expect(evidenceRecord.safeParse(fresh({ freshness: 'stale' })).success).toBe(false);
    // stale_reason 채우면 통과
    expect(
      evidenceRecord.safeParse(fresh({ freshness: 'stale', stale_reason: 'rebuilt since capture' }))
        .success,
    ).toBe(true);
  });

  test('cross-field (b): freshness=fresh 인데 stale_reason 이 있으면 reject', () => {
    expect(evidenceRecord.safeParse(fresh({ stale_reason: 'x' })).success).toBe(false);
  });

  test('cross-field (c): portability=committed 인데 artifact_available=false 면 reject', () => {
    expect(evidenceRecord.safeParse(fresh({ artifact_available: false })).success).toBe(false);
  });

  test('clone 환경 fallback: local-artifact + artifact_available=false 라도 summary/exit_code/sha 로 판정 가능 (CONFORMS)', () => {
    const r = evidenceRecord.parse({
      ref: {
        kind: 'command' as const,
        command: 'bun test',
        summary: '460 pass',
        sha256: 'a'.repeat(64),
      },
      captured_at: '2026-05-26T00:00:00.000Z',
      freshness: 'fresh' as const,
      portability: 'local-artifact' as const,
      artifact_available: false,
      exit_code: 0,
      key_lines: ['460 pass', '0 fail'],
    });
    // raw 가 없어도(artifact_available=false) 판정 메타가 살아있다.
    expect(r.artifact_available).toBe(false);
    expect(r.exit_code).toBe(0);
    expect(r.ref.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(r.key_lines.length).toBeGreaterThan(0);
  });

  test('evidence-index.json ledger: appendRecord → readIndex 라운드트립 + append-only', async () => {
    const es = new EvidenceStore(tmp);
    await es.appendRecord(wi.id, fresh({ ref: { kind: 'note', summary: 'first' } }));
    await es.appendRecord(wi.id, fresh({ ref: { kind: 'note', summary: 'second' } }));
    const idx = await es.readIndex(wi.id);
    expect(idx.work_item_id).toBe(wi.id);
    expect(idx.records.map((r) => r.ref.summary)).toEqual(['first', 'second']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M3.5 — dialectic runtime (OpponentModelRouter + admissibility + Stop cross-check)', () => {
  // 권위: dialectic-deliberation-contract.md §3(라우팅)·§6(admissibility), autopilot-contract §2.2.
  // 결정: dialectic 은 새 nodeKind 가 아니라 review/high-impact 노드의 검증 메커니즘.

  const policy = (over: Record<string, unknown> = {}) => ({
    producer: 'current-host',
    opponent_preferred: 'codex',
    opponent_fallback: ['claude-opus', 'claude-sonnet'],
    synthesizer: 'claude-opus',
    ...over,
  });

  test('OpponentModelRouter: Codex 우선, 가용 시 fallback 없음 (provenance none)', () => {
    const sel = selectOpponent(
      resolveOpponentCandidates(policy(), { currentHost: 'claude-code' }),
      () => ({
        available: true,
      }),
    );
    expect(sel.provider).toBe('codex');
    expect(sel.fallback_from).toBe(null);
    expect(sel.fallback_reason).toBe('none');
  });

  test('OpponentModelRouter: Claude Code host에서 Codex 불가 → claude fallback + 사유 기록 (침묵 금지, §3.2/§3.5)', () => {
    const sel = selectOpponent(
      resolveOpponentCandidates(policy(), { currentHost: 'claude-code' }),
      (c) => (c.token === 'codex' ? { available: false, reason: 'auth' } : { available: true }),
    );
    expect(sel.provider).toBe('claude-code');
    expect(sel.fallback_from).toBe('codex');
    expect(sel.fallback_reason).toBe('auth');
  });

  test('OpponentModelRouter: Codex host는 Claude Code 역호출 fallback 없이 context-separated Codex만 후보로 둔다', () => {
    const cands = resolveOpponentCandidates(policy(), { currentHost: 'codex' });
    expect(cands.map((c) => c.provider)).toEqual(['codex']);
    expect(() => selectOpponent(cands, () => ({ available: false, reason: 'runtime' }))).toThrow(
      NoOpponentAvailableError,
    );
  });

  // admissibility: maps_to(oracle) ∧ severity critical|high. medium 이하·oracle 없음 = taste.
  const baseObjection = (over: Record<string, unknown> = {}) => ({
    severity: 'critical' as const,
    claim: 'AC-1 fails on empty input',
    evidence: [],
    maps_to: 'AC-1',
    failure_mode: 'returns 500',
    required_fix: 'guard empty',
    ...over,
  });

  const buildDialectic = (over: Partial<Dialectic> = {}): Dialectic =>
    dialecticSchema.parse({
      schema_version: '0.1.0',
      review_id: 'rv_dia00001',
      input: { mode: 'review', target_artifact: 'src/api.ts', question: 'is it correct?' },
      producer: { position: 'looks correct', proposal: 'ship' },
      opponent: {
        run: {
          provider: 'codex',
          model: 'codex',
          command: 'codex review',
          timestamp: '2026-05-26T00:00:00.000Z',
        },
        objections: [baseObjection()],
      },
      synthesizer: {
        verdict: 'accept',
        synthesis: 'agreed',
        accepted_objections: ['AC-1 fails on empty input'],
      },
      ...over,
    });

  test('admissible objection resolved + verdict accept → continuation 없음', () => {
    expect(dialecticForcesContinuation(buildDialectic())).toEqual([]);
  });

  // wi_260606ezn — multi-round convergence: a `revise` with rounds remaining is
  // not a close; it re-deliberates. Default max_rounds=1 preserves the 1-round default.
  const reviseSynth = (edits: string[]) => ({
    verdict: 'revise' as const,
    synthesis: 'fix then re-deliberate',
    accepted_objections: ['AC-1 fails on empty input'], // objection resolved → only the revise-round branch is under test
    rejected_objections: [],
    required_edits: edits,
    remaining_open_questions: [],
    evidence_refs: [],
  });

  test('revise + round < max_rounds + required_edits → 재심의 continuation (다회차 수렴)', () => {
    const d = buildDialectic({
      round: 1,
      input: {
        mode: 'review',
        target_artifact: 'src/api.ts',
        question: 'q',
        constraints: { max_rounds: 3 },
      } as Dialectic['input'],
      synthesizer: reviseSynth(['add empty-input guard']),
    });
    expect(dialecticForcesContinuation(d).length).toBeGreaterThan(0);
  });

  test('revise + round = max_rounds(기본 1) → 종료 (무한 debate 금지 기본 보존)', () => {
    const d = buildDialectic({ round: 1, synthesizer: reviseSynth(['x']) }); // max_rounds default 1
    expect(dialecticForcesContinuation(d)).toEqual([]);
  });

  test('revise + round = max_rounds>1 → 종료 (cap 도달 = non-pass 종결, ≠ silent accept)', () => {
    const d = buildDialectic({
      round: 3,
      input: {
        mode: 'review',
        target_artifact: 'src/api.ts',
        question: 'q',
        constraints: { max_rounds: 3 },
      } as Dialectic['input'],
      synthesizer: reviseSynth(['x']),
    });
    expect(dialecticForcesContinuation(d)).toEqual([]);
  });

  test('verdict reject/blocked → continuation', () => {
    const reject = buildDialectic({
      synthesizer: {
        verdict: 'reject',
        synthesis: 'no',
        accepted_objections: [],
        rejected_objections: [],
        required_edits: [],
        remaining_open_questions: [],
        evidence_refs: [],
      },
    });
    expect(dialecticForcesContinuation(reject).length).toBeGreaterThan(0);
  });

  test('admissible objection 미해결(accept verdict라도) → continuation', () => {
    const unresolved = buildDialectic({
      synthesizer: {
        verdict: 'accept',
        synthesis: 'agreed',
        accepted_objections: [],
        rejected_objections: [],
        required_edits: [],
        remaining_open_questions: [],
        evidence_refs: [],
      },
    });
    expect(dialecticForcesContinuation(unresolved).some((r) => r.includes('admissible'))).toBe(
      true,
    );
  });

  test('taste(medium severity) 미해결은 blocker 아님 (continuation 없음)', () => {
    const taste = buildDialectic({
      opponent: {
        run: {
          provider: 'codex',
          model: 'codex',
          command: 'c',
          timestamp: '2026-05-26T00:00:00.000Z',
          fallback_from: null,
          fallback_reason: 'none',
        },
        objections: [baseObjection({ severity: 'medium' })],
        missing_alternatives: [],
        scope_creep_risks: [],
        verification_gaps: [],
      },
      synthesizer: {
        verdict: 'accept',
        synthesis: 'agreed',
        accepted_objections: [],
        rejected_objections: [],
        required_edits: [],
        remaining_open_questions: [],
        evidence_refs: [],
      },
    });
    expect(dialecticForcesContinuation(taste)).toEqual([]);
  });

  test('admissible objection을 id로 해결(claim 의역) → continuation 없음', () => {
    const byId = buildDialectic({
      opponent: {
        run: {
          provider: 'codex',
          model: 'codex',
          command: 'c',
          timestamp: '2026-05-26T00:00:00.000Z',
          fallback_from: null,
          fallback_reason: 'none',
        },
        objections: [baseObjection({ id: 'obj-1' })],
        missing_alternatives: [],
        scope_creep_risks: [],
        verification_gaps: [],
      },
      synthesizer: {
        verdict: 'accept',
        synthesis: 'agreed',
        // claim 문자열은 echo하지 않고 의역만; id로만 해결.
        accepted_objections: ['obj-1'],
        rejected_objections: [],
        required_edits: [],
        remaining_open_questions: [],
        evidence_refs: [],
      },
    });
    expect(dialecticForcesContinuation(byId)).toEqual([]);
  });

  test('admissible objection에 id 있으나 id도 claim도 echo 안 됨 → continuation', () => {
    const neither = buildDialectic({
      opponent: {
        run: {
          provider: 'codex',
          model: 'codex',
          command: 'c',
          timestamp: '2026-05-26T00:00:00.000Z',
          fallback_from: null,
          fallback_reason: 'none',
        },
        objections: [baseObjection({ id: 'obj-1' })],
        missing_alternatives: [],
        scope_creep_risks: [],
        verification_gaps: [],
      },
      synthesizer: {
        verdict: 'accept',
        synthesis: 'agreed',
        accepted_objections: ['something else'],
        rejected_objections: [],
        required_edits: [],
        remaining_open_questions: [],
        evidence_refs: [],
      },
    });
    expect(dialecticForcesContinuation(neither).some((r) => r.includes('admissible'))).toBe(true);
  });

  test('verbatim claim echo는 id가 있어도 여전히 해결로 인정 (backward-compat)', () => {
    const verbatim = buildDialectic({
      opponent: {
        run: {
          provider: 'codex',
          model: 'codex',
          command: 'c',
          timestamp: '2026-05-26T00:00:00.000Z',
          fallback_from: null,
          fallback_reason: 'none',
        },
        objections: [baseObjection({ id: 'obj-1' })],
        missing_alternatives: [],
        scope_creep_risks: [],
        verification_gaps: [],
      },
      synthesizer: {
        verdict: 'accept',
        synthesis: 'agreed',
        // id 대신 claim 문자열 verbatim echo.
        accepted_objections: ['AC-1 fails on empty input'],
        rejected_objections: [],
        required_edits: [],
        remaining_open_questions: [],
        evidence_refs: [],
      },
    });
    expect(dialecticForcesContinuation(verbatim)).toEqual([]);
  });

  test('Stop hook 통합: reviews/dialectic-*.json verdict=reject → exit 2 + dialectic 사유', async () => {
    const reviewsDir = join(tmp, '.ditto', 'local', 'work-items', wi.id, 'reviews');
    await mkdir(reviewsDir, { recursive: true });
    const reject = buildDialectic({
      synthesizer: {
        verdict: 'blocked',
        synthesis: 'blocked',
        accepted_objections: [],
        rejected_objections: [],
        required_edits: [],
        remaining_open_questions: ['needs decision'],
        evidence_refs: [],
      },
    });
    await writeFile(join(reviewsDir, 'dialectic-1.json'), JSON.stringify(reject));
    const res = await stopHandler({ raw: { session_id: SESSION }, repoRoot: tmp, env: {} });
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('dialectic');
  });

  test('Stop hook 통합: malformed reviews/dialectic-*.json → exit 2 (fail-closed)', async () => {
    const reviewsDir = join(tmp, '.ditto', 'local', 'work-items', wi.id, 'reviews');
    await mkdir(reviewsDir, { recursive: true });
    await writeFile(join(reviewsDir, 'dialectic-1.json'), '{"schema_version":"0.1.0"}');
    const res = await stopHandler({ raw: { session_id: SESSION }, repoRoot: tmp, env: {} });
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('malformed');
  });
});
