import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordTurn, startInterview } from '~/core/interview-driver';
import { WorkItemStore } from '~/core/work-item-store';
import { finalizeFromDesignDoc } from './finalize';

// ─────────────────────────────────────────────────────────────────────────────
// Named regression oracle (wi_260723lny, ac-4): the post-answer intent-summary wiring
// is ADDITIVE-OPTIONAL on the finalize path. finalizeFromDesignDoc (finalize.ts:69-85)
// calls finalizeInterview WITHOUT any per-answer summaries and finalizes successfully —
// the prism → deep-interview compile path stays unbroken. A red here means the summary
// wiring became load-bearing on the prism path — a real regression.
// ─────────────────────────────────────────────────────────────────────────────

// A minimal spec/design document that compiles (COMPILE_INPUT_SECTIONS: 요약·목표·비목표·완료 조건·위험).
const DESIGN_DOC = `## 요약
비밀번호 강도를 0-100 점수로 반환하는 엔드포인트를 추가한다.

## 목표
- 점수 산출 엔드포인트를 추가한다

## 비목표
- 점수 이력 저장은 다루지 않는다

## 완료 조건
| id | statement | evidence |
| --- | --- | --- |
| ac-1 | 정수 0..100 점수를 반환한다 | test |

## 위험
| 위험 | 처리 |
| --- | --- |
| 점수 산식 정확도 | known |
`;

describe('prism finalize — additive-optional intent summaries', () => {
  let repo: string;
  let wiId: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-prism-finalize-'));
    const wi = await new WorkItemStore(repo).create({
      title: 'password strength endpoint',
      source_request: '점수 엔드포인트를 추가하라',
      goal: 'returns a 0-100 score for a password',
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 'TBD — derive during interview',
          verdict: 'unverified',
          evidence: [],
        },
      ],
    });
    wiId = wi.id;
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Oracle 3: finalizeFromDesignDoc finalizes with no per-answer summaries (prism path unbroken).
  test('oracle-3: finalizeFromDesignDoc finalizes WITHOUT per-answer summaries', async () => {
    // Drive the interview to a readiness-passing state (resolved critical dim + score ≥ threshold).
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-shape', critical: true, state: 'resolved', ambiguity: 0.5, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 쉬운 말로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: '점수는 어떻게 계산하나요?',
          why_matters: '응답 형태와 예외 처리를 좌우합니다.',
          info_gain_estimate: 'high',
        },
        answer: { text: '정수 0..100', kind: 'user' },
        readiness_score: 0.9,
      },
    });

    // Write the isomorphic design document at the default path the compile reads.
    await mkdir(join(repo, '.ditto', 'specs'), { recursive: true });
    await writeFile(join(repo, '.ditto', 'specs', `${wiId}-design.md`), DESIGN_DOC, 'utf8');

    // finalizeFromDesignDoc carries NO IntentSummary — it builds the finalize payload and delegates
    // to finalizeInterview. A 'finalized' result proves the prism path needs no per-answer summaries.
    const result = await finalizeFromDesignDoc(repo, {
      workItemId: wiId,
      userConfirmation: { confirmed: true, statement: '네, 이 의도가 맞습니다' },
    });

    expect(result.status).toBe('finalized');
  });
});
