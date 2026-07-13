import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';
import { nextNode } from '~/core/autopilot-loop';
import { IntentStore } from '~/core/intent-store';
import { finalizeInterview, recordTurn, startInterview } from '~/core/interview-driver';
import { finalizeFromDesignDoc } from '~/core/prism/finalize';
import { runDivergenceRound } from '~/core/prism/loop';
import { PrismStore } from '~/core/prism/store';
import { computeSpecDigest } from '~/core/spec-doc';
import { WorkItemStore } from '~/core/work-item-store';

/**
 * oi1-compile-wiring (wi_260707oi1): the prism -> deep-interview compile.
 *
 * The autopilot digest-freshness GATE already exists (autopilot-loop.ts) and is
 * proven by autopilot-digest-gate.test.ts using a direct-stamp fixture. This suite
 * exercises the PRODUCTION path: the SINGLE intent writer (finalizeInterview)
 * STAMPS intent.source_digest when the intent is compiled from a spec/design doc,
 * so the gate actually fires -- without adding a second intent.json writer (ac-7).
 */

const DOC_PATH = (wi: string) => `.ditto/specs/${wi}-design.md`;

function designDoc(goals = '- 점수 API 제공', planHint = '엔드포인트 모양 힌트.'): string {
  return `# 데모 — 설계 문서

## 2. 요약

비밀번호 강도 점수 API를 추가한다.

## 4. 목표

${goals}

## 5. 비목표 (변경 경계)

- 비밀번호 정책 변경은 하지 않는다

## 6. 완료 조건 (Acceptance Criteria)

| id | 완료 조건 | evidence |
|---|---|---|
| ac-1 | 호출 시 200과 score 0-100을 반환한다 | test |

## 7. 위험 / Pre-mortem

| 위험 | 처리 | 플래그 |
|---|---|---|

## 8. 계획 (Plan)

> ⚠ 비구속(non-binding) 설계 힌트.

${planHint}
`;
}

let repo: string;
let wiId: string;

async function writeDoc(content: string, wi = wiId): Promise<void> {
  await mkdir(join(repo, '.ditto', 'specs'), { recursive: true });
  await writeFile(join(repo, DOC_PATH(wi)), content, 'utf8');
}

/** Drive the interview to a ready (readiness AND confirmable) state -- the finalize precondition. */
async function driveToReady(): Promise<void> {
  await startInterview(repo, { workItemId: wiId });
  await recordTurn(repo, {
    workItemId: wiId,
    payload: {
      dimension: { id: 'd-shape', critical: true, state: 'resolved', ambiguity: 0.05, notes: '' },
      question: {
        text: 'shape?',
        why_matters: 'response',
        user_explanation: '응답 값의 형태를 무엇으로 정할지 사용자 언어로 확인하는 질문입니다.',
        info_gain_estimate: 'high',
      },
      answer: { text: 'integer 0..100', kind: 'user' },
      readiness_score: 0.85,
    },
  });
}

const READY_PAYLOAD = {
  goal: 'returns integer score 0..100 for a password',
  in_scope: ['POST /password-strength'],
  out_of_scope: ['storage'],
  acceptance_criteria: [
    {
      id: 'ac-1',
      statement: 'returns integer 0..100',
      verdict: 'unverified' as const,
      evidence: [],
      evidence_required: ['test' as const],
    },
  ],
  unknowns: [],
  follow_up_candidates: [],
  question_policy: 'ask_only_if_user_only_can_answer' as const,
  risk: { non_local: false, irreversible: false, unaudited: false },
  user_confirmation: { confirmed: true, statement: '네, 이 의도가 맞습니다' },
};

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-ic-'));
  const wi = await new WorkItemStore(repo).create({
    title: 'password strength endpoint',
    source_request: 'add a /password-strength endpoint',
    goal: 'returns a 0-100 score for a password',
    acceptance_criteria: [{ id: 'ac-1', statement: 'TBD', verdict: 'unverified', evidence: [] }],
  });
  wiId = wi.id;
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

// -- ac-6/ac-7 . the single writer stamps source_digest -----------------------
describe('finalizeInterview stamps source_digest (ac-6 stamping through the single writer)', () => {
  test('a sourceDigest input is stamped onto intent.source_digest', async () => {
    await driveToReady();
    const doc = designDoc();
    const digest = computeSpecDigest(doc);
    const result = await finalizeInterview(repo, {
      workItemId: wiId,
      payload: READY_PAYLOAD,
      sourceDigest: { doc_path: DOC_PATH(wiId), sha256: digest },
    });
    expect(result.status).toBe('finalized');
    const intent = await new IntentStore(repo).get(wiId);
    expect(intent.source_digest).toBeDefined();
    expect(intent.source_digest?.doc_path).toBe(DOC_PATH(wiId));
    expect(intent.source_digest?.sha256).toBe(digest);
  });

  test('no sourceDigest input -> intent carries no source_digest (interview-only zero-diff)', async () => {
    await driveToReady();
    const result = await finalizeInterview(repo, { workItemId: wiId, payload: READY_PAYLOAD });
    expect(result.status).toBe('finalized');
    const intent = await new IntentStore(repo).get(wiId);
    expect(intent.source_digest).toBeUndefined();
  });
});

// -- ac-6/ac-7 . prism finalize routes through the compile + fires the gate ----
describe('finalizeFromDesignDoc — prism confirmation → deep-interview compile (ac-6, ac-7)', () => {
  test('compiles the design doc through finalizeInterview, stamping source_digest', async () => {
    await driveToReady();
    const doc = designDoc();
    await writeDoc(doc);
    const result = await finalizeFromDesignDoc(repo, {
      workItemId: wiId,
      userConfirmation: { confirmed: true, statement: '이 설계로 확정합니다' },
    });
    expect(result.status).toBe('finalized');
    const intent = await new IntentStore(repo).get(wiId);
    // Compiled FROM the design doc (goal = 요약, AC from the table).
    expect(intent.goal).toBe('비밀번호 강도 점수 API를 추가한다.');
    expect(intent.acceptance_criteria.map((a) => a.id)).toContain('ac-1');
    // Bound to the design doc by digest.
    expect(intent.source_digest?.doc_path).toBe(DOC_PATH(wiId));
    expect(intent.source_digest?.sha256).toBe(computeSpecDigest(doc));
  });

  test('missing design doc → compile_rejected (fail-closed, no intent written)', async () => {
    await driveToReady();
    const result = await finalizeFromDesignDoc(repo, {
      workItemId: wiId,
      userConfirmation: { confirmed: true, statement: '확정' },
    });
    expect(result.status).toBe('compile_rejected');
    expect(await new IntentStore(repo).exists(wiId)).toBe(false);
  });

  test('fresh doc → autopilot loop is NOT blocked by the digest gate', async () => {
    await driveToReady();
    await writeDoc(designDoc());
    expect(
      (
        await finalizeFromDesignDoc(repo, {
          workItemId: wiId,
          userConfirmation: { confirmed: true, statement: '확정' },
        })
      ).status,
    ).toBe('finalized');
    const res = await nextNode(repo, wiId);
    expect(res.action).not.toBe('blocked');
  });

  test('compile-input section edited after finalize → next-node BLOCKED (gate fires)', async () => {
    await driveToReady();
    await writeDoc(designDoc());
    await finalizeFromDesignDoc(repo, {
      workItemId: wiId,
      userConfirmation: { confirmed: true, statement: '확정' },
    });
    // Mutate a compile-input section (목표) — inside the digest range.
    await writeDoc(designDoc('- 완전히 다른 목표'));
    const res = await nextNode(repo, wiId);
    expect(res.action).toBe('blocked');
    if (res.action === 'blocked') expect(res.reason).toContain('deep-interview finalize');
  });

  test('non-compile-input section edited → next-node NOT blocked (outside digest range)', async () => {
    await driveToReady();
    await writeDoc(designDoc());
    await finalizeFromDesignDoc(repo, {
      workItemId: wiId,
      userConfirmation: { confirmed: true, statement: '확정' },
    });
    // Mutate the 계획 (plan) section only — outside the digest range.
    await writeDoc(designDoc('- 점수 API 제공', '계획 전면 교체.'));
    const res = await nextNode(repo, wiId);
    expect(res.action).not.toBe('blocked');
  });

  test('spec doc deleted after finalize → next-node BLOCKED (fail-closed)', async () => {
    await driveToReady();
    await writeDoc(designDoc());
    await finalizeFromDesignDoc(repo, {
      workItemId: wiId,
      userConfirmation: { confirmed: true, statement: '확정' },
    });
    await unlink(join(repo, DOC_PATH(wiId)));
    const res = await nextNode(repo, wiId);
    expect(res.action).toBe('blocked');
  });
});

// -- ac-7 . exactly one intent.json writer, no second path added --------------
describe('ac-7 single intent.json writer invariant', () => {
  test('finalizeFromDesignDoc routes THROUGH finalizeInterview and never writes intent.json itself', async () => {
    const src = await readFile(join(process.cwd(), 'src/core/prism/finalize.ts'), 'utf8');
    expect(src).toContain('finalizeInterview');
    // No intent-store instantiation and no intent write call (the comment may mention it).
    expect(src).not.toMatch(/new IntentStore\b/);
    expect(src).not.toMatch(/intentStore\.write\(/);
  });

  test('the set of files calling intentStore.write is unchanged (no NEW writer)', async () => {
    // Invariant: the ONLY intent.json write sites are the deep-interview finalize (the
    // single canonical writer) and the pre-existing follow-up batch materializer (a
    // re-write of the SAME intent). Wiring prism finalize must add NEITHER a new one.
    const writers: string[] = [];
    const glob = new Glob('**/*.ts');
    for await (const rel of glob.scan({ cwd: join(process.cwd(), 'src') })) {
      const text = await readFile(join(process.cwd(), 'src', rel), 'utf8');
      if (/intentStore\.write\(/.test(text)) writers.push(`src/${rel}`);
    }
    expect(writers.sort()).toEqual(['src/cli/commands/work.ts', 'src/core/interview-driver.ts']);
  });
});

// -- ac-10 . divergence decisions are actually EMITTED during the loop ---------
describe('ac-10 divergence decisions emitted (challenge_admit / early_exit)', () => {
  test('a challenge WITH new evidence emits a durable challenge_admit decision', async () => {
    const store = new PrismStore(repo);
    const res = await runDivergenceRound(store, {
      workItemId: wiId,
      round: {
        challenge: { decided_id: 'prism_d0000001', signature: 'X 다시', new_evidence: true },
      },
      history: [],
    });
    expect(res.verdict.action).toBe('challenge-node');
    expect(res.decision?.kind).toBe('challenge_admit');
    const persisted = await store.readDecisions(wiId);
    expect(persisted.map((d) => d.kind)).toContain('challenge_admit');
  });

  test('a meaningless divergence (repeat question) emits a durable early_exit decision', async () => {
    const store = new PrismStore(repo);
    const res = await runDivergenceRound(store, {
      workItemId: wiId,
      round: { question: { signature: '재시도 횟수?', trivial: false } },
      history: [{ signature: '재시도 횟수?', trivial: false }],
    });
    expect(res.verdict.diverged).toBe(true);
    expect(res.decision?.kind).toBe('early_exit');
    const persisted = await store.readDecisions(wiId);
    expect(persisted.map((d) => d.kind)).toContain('early_exit');
  });

  test('no divergence → no decision emitted (never a spurious record)', async () => {
    const store = new PrismStore(repo);
    const res = await runDivergenceRound(store, {
      workItemId: wiId,
      round: { question: { signature: '완전히 새로운 질문?', trivial: false } },
      history: [{ signature: '이전 질문', trivial: false }],
    });
    expect(res.verdict.action).toBe('continue');
    expect(res.decision).toBeUndefined();
    expect(await store.readDecisions(wiId)).toHaveLength(0);
  });
});

// -- design point 4a . prism risk nodes carried into the pre-mortem seed -------
describe('prism risk nodes → pre-mortem seed (design point 4a)', () => {
  test('still-open prism issue-map nodes land in intent.unknowns (surviving risk → plan seed)', async () => {
    await driveToReady();
    await writeDoc(designDoc());
    const store = new PrismStore(repo);
    await store.writeMap({
      schema_version: '0.1.0',
      work_item_id: wiId,
      tree: {
        schema_version: '0.1.0',
        work_item_id: wiId,
        root_id: 'prism_root0001',
        nodes: [
          {
            id: 'prism_root0001',
            parent_id: null,
            label: 'original intent',
            origin: 'seed',
            depth_weight: 1,
            state: 'open',
            children: [],
          },
          {
            id: 'prism_risk0002',
            parent_id: 'prism_root0001',
            label: '레이트 리밋 미결',
            origin: 'derived',
            depth_weight: 0.5,
            state: 'open',
            children: [],
          },
          {
            id: 'prism_done0003',
            parent_id: 'prism_root0001',
            label: '이미 정한 항목',
            origin: 'derived',
            depth_weight: 0.5,
            state: 'resolved',
            children: [],
          },
        ],
      },
      severities: [],
    });
    const result = await finalizeFromDesignDoc(repo, {
      workItemId: wiId,
      userConfirmation: { confirmed: true, statement: '확정' },
    });
    expect(result.status).toBe('finalized');
    const intent = await new IntentStore(repo).get(wiId);
    expect(intent.unknowns).toContain('레이트 리밋 미결');
    expect(intent.unknowns).not.toContain('이미 정한 항목');
    expect(intent.unknowns).not.toContain('original intent');
  });
});

// -- design point 4b . idempotent, safe re-entry ------------------------------
describe('finalizeFromDesignDoc is idempotent / safe to re-enter (design point 4b)', () => {
  test('a second call recompiles + re-finalizes (safe resume, digest still bound, not forked)', async () => {
    await driveToReady();
    await writeDoc(designDoc());
    const first = await finalizeFromDesignDoc(repo, {
      workItemId: wiId,
      userConfirmation: { confirmed: true, statement: '확정' },
    });
    const second = await finalizeFromDesignDoc(repo, {
      workItemId: wiId,
      userConfirmation: { confirmed: true, statement: '다시 확정' },
    });
    expect(first.status).toBe('finalized');
    expect(second.status).toBe('finalized');
    const intent = await new IntentStore(repo).get(wiId);
    expect(intent.source_digest?.sha256).toBe(computeSpecDigest(designDoc()));
    // The re-finalized intent is still fresh vs the doc → the gate does not block.
    expect((await nextNode(repo, wiId)).action).not.toBe('blocked');
  });
});
