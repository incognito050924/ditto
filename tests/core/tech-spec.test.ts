import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutopilotStore } from '~/core/autopilot-store';
import { IntentStore } from '~/core/intent-store';
import { startInterview } from '~/core/interview-driver';
import {
  compileSpecDoc,
  computeSpecDigest,
  finalizeTechSpec,
  finalizeTechSpecPayload,
  recordRound,
  recordRoundPayload,
  recordSection,
  recordSectionPayload,
  startTechSpec,
} from '~/core/tech-spec';
import { TechSpecStore } from '~/core/tech-spec-store';
import { WorkItemStore } from '~/core/work-item-store';

/** Minimal valid spec doc following skills/tech-spec/TEMPLATE.md section titles. */
function specDoc(overrides: Partial<Record<string, string>> = {}): string {
  const ac =
    overrides.ac ??
    `| id | 완료 조건 (관찰가능 술어) | evidence |
|---|---|---|
| ac-1 | 호출 시 200과 score 0-100을 반환한다 | test |
| ac-2 | 잘못된 입력은 422로 거부된다 | test |`;
  return `# 데모 — 테크스펙

> 소비자: DITTO(design → implement → verify) + 사람.

## 1. 기능

- 이름: 데모

## 2. 요약

${overrides.summary ?? '비밀번호 강도 점수 API를 추가한다.'}

## 3. 배경 [장]

기존 회원가입에 강도 검증이 없다.

## 4. 목표

${overrides.goals ?? '- 점수 API 제공\n- 가입 폼 연동'}

## 5. 비목표 (변경 경계) [장]

${overrides.nonGoals ?? '- 비밀번호 정책 변경은 하지 않는다'}

## 6. 완료 조건 (Acceptance Criteria)

${ac}

## 7. 위험 / Pre-mortem

| 위험 | 처리 | 플래그 |
|---|---|---|
| 사전 기반 공격 강도 미달 | unknown — 측정 후 결정 | — |

## 8. 계획 (Plan) [단]

> ⚠ 비구속(non-binding) 설계 힌트.

${overrides.plan ?? '엔드포인트 모양 힌트.'}

## 9. 영향도 · 의존성

signup 폼.

## 10. 기각된 대안 [장]

없음.

## 11. 마일스톤 [단]

미정.

## 12. 인터뷰 기록

없음.

## 13. 빌드 후 처리

승격 예정.
`;
}

describe('compileSpecDoc', () => {
  test('compiles a valid doc into intent fields with a digest', () => {
    const res = compileSpecDoc(specDoc());
    if (res.status !== 'compiled') throw new Error(res.reasons.join('; '));
    expect(res.fields.goal).toBe('비밀번호 강도 점수 API를 추가한다.');
    expect(res.fields.in_scope).toEqual(['점수 API 제공', '가입 폼 연동']);
    expect(res.fields.out_of_scope).toEqual(['비밀번호 정책 변경은 하지 않는다']);
    expect(res.fields.acceptance_criteria).toEqual([
      {
        id: 'ac-1',
        statement: '호출 시 200과 score 0-100을 반환한다',
        verdict: 'unverified',
        evidence: [],
        evidence_required: ['test'],
      },
      {
        id: 'ac-2',
        statement: '잘못된 입력은 422로 거부된다',
        verdict: 'unverified',
        evidence: [],
        evidence_required: ['test'],
      },
    ]);
    // 위험 표에서 처리=unknown 으로 표시된 행은 unknowns로 수집된다
    expect(res.fields.unknowns).toEqual(['사전 기반 공격 강도 미달']);
    expect(res.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects when a required compile-input section is missing (fail-closed, with location)', () => {
    const doc = specDoc().replace(/## 5\. 비목표[^\n]*\n\n[^\n]+\n/, '');
    const res = compileSpecDoc(doc);
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') {
      expect(res.reasons.join('\n')).toContain('비목표');
    }
  });

  test('rejects duplicate AC ids', () => {
    const res = compileSpecDoc(
      specDoc({
        ac: `| id | 완료 조건 | evidence |
|---|---|---|
| ac-1 | 호출 시 200을 반환한다 | test |
| ac-1 | 잘못된 입력은 422로 거부된다 | test |`,
      }),
    );
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') {
      expect(res.reasons.join('\n')).toContain('ac-1');
    }
  });

  test('rejects an AC row whose evidence kind is not in the enum', () => {
    const res = compileSpecDoc(
      specDoc({
        ac: `| id | 완료 조건 | evidence |
|---|---|---|
| ac-1 | 호출 시 200을 반환한다 | vibes |`,
      }),
    );
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') {
      expect(res.reasons.join('\n')).toContain('vibes');
    }
  });

  test('rejects when the AC table has no rows', () => {
    const res = compileSpecDoc(specDoc({ ac: '(작성 예정)' }));
    expect(res.status).toBe('rejected');
  });

  test('rejects a duplicated compile-input section (ambiguous source)', () => {
    const doc = `${specDoc()}\n## 4. 목표\n\n- 중복 섹션\n`;
    const res = compileSpecDoc(doc);
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') {
      expect(res.reasons.join('\n')).toContain('목표');
    }
  });
});

describe('startTechSpec / recordSection (ac-9)', () => {
  let repo: string;
  let wiId: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-ts-'));
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

  test('start writes tech-spec-state.json with doc path and default stepwise mode', async () => {
    const state = await startTechSpec(repo, { workItemId: wiId, docPath: '.ditto/specs/demo.md' });
    expect(state.work_item_id).toBe(wiId);
    expect(state.doc_path).toBe('.ditto/specs/demo.md');
    expect(state.mode).toBe('stepwise');
    expect(state.sections).toEqual([]);
    expect(await new TechSpecStore(repo).exists(wiId)).toBe(true);
  });

  test('factual section without grounding evidence is rejected at the schema (ac-9)', () => {
    const parsed = recordSectionPayload.safeParse({
      section: { id: 'background', review: 'reviewed' },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain('근거');
    }
  });

  test('factual section with memory evidence is accepted and upserted', async () => {
    await startTechSpec(repo, { workItemId: wiId, docPath: '.ditto/specs/demo.md' });
    const payload = recordSectionPayload.parse({
      section: {
        id: 'background',
        review: 'reviewed',
        evidence: [{ kind: 'memory', projection_id: 'proj_123', freshness: 'fresh' }],
      },
    });
    const state = await recordSection(repo, { workItemId: wiId, payload });
    expect(state.sections).toHaveLength(1);
    expect(state.sections[0]?.id).toBe('background');
    expect(state.sections[0]?.review).toBe('reviewed');
  });

  test('same section id upserts in place (no duplicates)', async () => {
    await startTechSpec(repo, { workItemId: wiId, docPath: '.ditto/specs/demo.md' });
    const first = recordSectionPayload.parse({ section: { id: 'summary', review: 'pending' } });
    await recordSection(repo, { workItemId: wiId, payload: first });
    const second = recordSectionPayload.parse({ section: { id: 'summary', review: 'reviewed' } });
    const state = await recordSection(repo, { workItemId: wiId, payload: second });
    expect(state.sections).toHaveLength(1);
    expect(state.sections[0]?.review).toBe('reviewed');
  });

  test('non-factual section without evidence passes the schema', () => {
    const parsed = recordSectionPayload.safeParse({ section: { id: 'goals', review: 'reviewed' } });
    expect(parsed.success).toBe(true);
  });
});

describe('finalizeTechSpec (ac-5, ac-10)', () => {
  let repo: string;
  let wiId: string;
  const DOC_PATH = '.ditto/specs/demo.md';

  const confirmedPayload = () =>
    finalizeTechSpecPayload.parse({
      user_confirmation: { confirmed: true, statement: '의도 일치 확인' },
    });

  async function writeDoc(content: string): Promise<void> {
    await mkdir(join(repo, '.ditto', 'specs'), { recursive: true });
    await writeFile(join(repo, DOC_PATH), content, 'utf8');
  }

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-tsf-'));
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

  test('not_started when startTechSpec was never called', async () => {
    const res = await finalizeTechSpec(repo, { workItemId: wiId, payload: confirmedPayload() });
    expect(res.status).toBe('not_started');
  });

  test('compile_rejected on a doc missing required sections — no intent written', async () => {
    await writeDoc('# 빈 문서\n\n## 2. 요약\n\n내용.\n');
    await startTechSpec(repo, { workItemId: wiId, docPath: DOC_PATH });
    const res = await finalizeTechSpec(repo, { workItemId: wiId, payload: confirmedPayload() });
    expect(res.status).toBe('compile_rejected');
    expect(await new IntentStore(repo).exists(wiId)).toBe(false);
  });

  test('not_confirmed without user confirmation (2차 게이트, 모드 불변) — no intent written', async () => {
    await writeDoc(specDoc());
    await startTechSpec(repo, { workItemId: wiId, docPath: DOC_PATH });
    const payload = finalizeTechSpecPayload.parse({
      user_confirmation: { confirmed: false },
    });
    const res = await finalizeTechSpec(repo, { workItemId: wiId, payload });
    expect(res.status).toBe('not_confirmed');
    expect(await new IntentStore(repo).exists(wiId)).toBe(false);
  });

  test('finalized without interview (ac-10 강제 진입 없음): intent + digest + autopilot + AC 미러', async () => {
    await writeDoc(specDoc());
    await startTechSpec(repo, { workItemId: wiId, docPath: DOC_PATH });
    await recordSection(repo, {
      workItemId: wiId,
      payload: recordSectionPayload.parse({ section: { id: 'summary', review: 'reviewed' } }),
    });
    const res = await finalizeTechSpec(repo, { workItemId: wiId, payload: confirmedPayload() });
    if (res.status !== 'finalized') throw new Error(`unexpected: ${JSON.stringify(res)}`);

    // intent.json: 문서로부터 컴파일 + source_digest 스탬프 (ac-5)
    const intent = await new IntentStore(repo).get(wiId);
    expect(intent.goal).toBe('비밀번호 강도 점수 API를 추가한다.');
    expect(intent.acceptance_criteria.map((a) => a.id)).toEqual(['ac-1', 'ac-2']);
    expect(intent.source_digest?.doc_path).toBe(DOC_PATH);
    expect(intent.source_digest?.sha256).toBe(computeSpecDigest(specDoc()));

    // AC가 work item으로 미러된다 (completionGate 정합)
    const wi = await new WorkItemStore(repo).get(wiId);
    expect(wi.acceptance_criteria.map((a) => a.id)).toEqual(['ac-1', 'ac-2']);

    // autopilot 부트스트랩
    expect(await new AutopilotStore(repo).exists(wiId)).toBe(true);

    // 리뷰 커버리지가 finalize 산출물(state.finalized)에 기록된다 (design §8)
    const state = await new TechSpecStore(repo).get(wiId);
    expect(state.finalized?.digest).toBe(computeSpecDigest(specDoc()));
    const coverage = new Map(state.finalized?.review_coverage.map((c) => [c.id, c.review]));
    expect(coverage.get('summary')).toBe('reviewed');
    expect(coverage.get('goals')).toBe('pending');
  });

  test('interview_not_ready when an interview exists but its gate is blocked (ac-10)', async () => {
    await writeDoc(specDoc());
    await startTechSpec(repo, { workItemId: wiId, docPath: DOC_PATH });
    await startInterview(repo, { workItemId: wiId }); // active, readiness 0 → gate blocked
    const res = await finalizeTechSpec(repo, { workItemId: wiId, payload: confirmedPayload() });
    expect(res.status).toBe('interview_not_ready');
    expect(await new IntentStore(repo).exists(wiId)).toBe(false);
  });
});

describe('computeSpecDigest (해시 범위 = 컴파일 입력 섹션: 요약·목표·비목표·AC·위험)', () => {
  test('editing a non-compile-input section (계획) does not change the digest', () => {
    const a = computeSpecDigest(specDoc());
    const b = computeSpecDigest(specDoc({ plan: '완전히 다른 설계 힌트로 교체.' }));
    expect(a).toBe(b);
  });

  test('editing a compile-input section (목표) changes the digest', () => {
    const a = computeSpecDigest(specDoc());
    const b = computeSpecDigest(specDoc({ goals: '- 다른 목표' }));
    expect(a).not.toBe(b);
  });

  test('line endings and trailing whitespace are normalized', () => {
    const doc = specDoc();
    const noisy = doc.replace(/\n/g, '\r\n').replace(/점수 API 제공/, '점수 API 제공   ');
    expect(computeSpecDigest(noisy)).toBe(computeSpecDigest(doc));
  });
});

describe('recordRound (증분 3 — 점수 영속 sink)', () => {
  let repo: string;
  let wiId: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-tsr-'));
    const wi = await new WorkItemStore(repo).create({
      title: 'demo',
      source_request: 'demo',
      goal: 'demo',
      acceptance_criteria: [{ id: 'ac-1', statement: 'TBD', verdict: 'unverified', evidence: [] }],
    });
    wiId = wi.id;
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const score = { consensus: 2, quality: 0.8, necessity: 0.7, answer_value: 0.9 };

  test('appends a round to tech-spec-rounds.jsonl, stamping ts + work_item_id', async () => {
    const payload = recordRoundPayload.parse({
      round: 1,
      section: 'background',
      dry: false,
      selected: [{ text: 'enforce JWT here?', property: 'blind-spot', scores: score }],
      all_scored: [{ text: 'enforce JWT here?', property: 'blind-spot', scores: score }],
    });
    const record = await recordRound(repo, {
      workItemId: wiId,
      payload,
      now: new Date('2026-06-19T05:00:00.000Z'),
    });
    expect(record.work_item_id).toBe(wiId);
    expect(record.ts).toBe('2026-06-19T05:00:00.000Z');
    const rounds = await new WorkItemStore(repo).readTechSpecRounds(wiId);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.selected[0]?.scores.answer_value).toBe(0.9);
    expect(rounds[0]?.generator_count).toBe(3);
  });

  test('multiple rounds append (not overwrite)', async () => {
    await recordRound(repo, {
      workItemId: wiId,
      payload: recordRoundPayload.parse({
        round: 1,
        dry: false,
        selected: [{ text: 'q', property: 'blind-spot', scores: score }],
      }),
    });
    await recordRound(repo, {
      workItemId: wiId,
      payload: recordRoundPayload.parse({ round: 2, dry: true }),
    });
    const rounds = await new WorkItemStore(repo).readTechSpecRounds(wiId);
    expect(rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(rounds[1]?.dry).toBe(true);
  });

  test('recording a round for a missing work item throws', async () => {
    await expect(
      recordRound(repo, {
        workItemId: 'wi_doesnotexist',
        payload: recordRoundPayload.parse({ round: 1, dry: true }),
      }),
    ).rejects.toThrow();
  });
});
