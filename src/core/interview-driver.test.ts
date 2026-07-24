import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interviewReadinessGate } from '~/core/gates';
import {
  type RecordTurnPayload,
  finalizeInterview,
  recordFireRejection,
  recordTurn,
  startInterview,
} from '~/core/interview-driver';
import { InterviewStore } from '~/core/interview-store';
import { WorkItemStore } from '~/core/work-item-store';
import type { InterviewState } from '~/schemas/interview-state';

// ── fixtures ─────────────────────────────────────────────────────────────────

let repo: string;
let wiId: string;

// The verbatim source_request carries internal-vocab tokens (§, ADR-, wi_) on purpose:
// they must ride the scan-EXEMPT anchor tier without false-tripping the leak scan (ac-3).
const SOURCE_REQUEST = '§6.3 ADR-0002 wi_260723lny 원 발화: 점수 엔드포인트를 추가하라';

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-ivd-'));
  const wi = await new WorkItemStore(repo).create({
    title: 'password strength endpoint',
    source_request: SOURCE_REQUEST,
    goal: 'returns a 0-100 score for a password',
    acceptance_criteria: [
      {
        id: 'ac-1',
        statement: 'TBD — derive observable criteria during interview',
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

/** A presentation-contract-clean question payload (passes layer-1). */
function goodQuestion(
  over: Partial<RecordTurnPayload['question']> = {},
): RecordTurnPayload['question'] {
  return {
    user_explanation: '이 질문이 무엇을 결정하는지 쉬운 말로 설명합니다.',
    recommended_answer: '추천 답변 예시입니다.',
    text: '점수는 어떻게 계산하나요?',
    why_matters: '응답 형태와 예외 처리를 좌우합니다.',
    info_gain_estimate: 'high',
    ...over,
  };
}

/** A payload that FAILS layer-1 (no user_explanation / recommended_answer). */
function badQuestion(): RecordTurnPayload['question'] {
  return {
    text: '점수는 어떻게 계산하나요?',
    why_matters: 'x',
    info_gain_estimate: 'low',
  };
}

function critDim(id: string, state: 'unknown' | 'partial' | 'resolved' = 'partial') {
  return { id, critical: true, state, ambiguity: 0.5, notes: '' } as const;
}

// ── Part C (i): cap no longer terminates ─────────────────────────────────────

describe('ac-5 cap removed from termination judgment', () => {
  test('reaching the cap count with unresolved questions does NOT converge or set cap_reached', async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 2 });
    for (let i = 0; i < 3; i++) {
      await recordTurn(repo, {
        workItemId: wiId,
        payload: { dimension: critDim(`d${i}`), question: goodQuestion({ text: `q${i}?` }) },
      });
    }
    const state = await new InterviewStore(repo).get(wiId);
    // questions_asked (fired) is past the cap, yet the interview is NOT mechanically closed.
    expect(state.exit.questions_asked).toBe(3);
    expect(state.exit.question_cap).toBe(2); // cap still WRITTEN (write-side-only removal)
    expect(state.exit.reason).not.toBe('cap_reached');
    expect(state.status).toBe('active'); // not converged
    expect(state.readiness.gate).toBe('blocked'); // critical dims unresolved
  });
});

// ── Part C (ii)+(iii): finite-termination — both rejection paths → bound K park ─

describe('ac-5 finite-termination fire-rejection counter', () => {
  test('(iii) repeated write-path (layer-1) rejection → bound K → parked, no livelock', async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
    // Seed one unresolved dimension so the parked surface exposes a non-empty unresolved set.
    await recordTurn(repo, {
      workItemId: wiId,
      payload: { dimension: critDim('d-open'), question: goodQuestion() },
    });

    // First rejection (attempts 1 < K=2): throws, does NOT park.
    await expect(
      recordTurn(repo, {
        workItemId: wiId,
        payload: { dimension: critDim('d-open'), question: badQuestion() },
      }),
    ).rejects.toThrow(/presentation contract/);
    let state = await new InterviewStore(repo).get(wiId);
    expect(state.exit.reason).not.toBe('parked');

    // Second rejection (attempts 2 >= K): RETURNS a parked state instead of throwing (no livelock).
    const parked = await recordTurn(repo, {
      workItemId: wiId,
      payload: { dimension: critDim('d-open'), question: badQuestion() },
    });
    expect(parked.exit.reason).toBe('parked');
    expect(parked.status).toBe('active'); // non-terminating: NOT converged, finalize NOT reached
    state = await new InterviewStore(repo).get(wiId);
    expect(state.exit.reason).toBe('parked');
    expect(state.exit.closure_mode).toBe('safe_default');
  });

  test('(ii) repeated layer-2 intent-fidelity rejection → bound K → parked surfacing unresolved set', async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
    await recordTurn(repo, {
      workItemId: wiId,
      payload: { dimension: critDim('d-intent'), question: goodQuestion() },
    });
    const distorting = goodQuestion({
      intent_fidelity: { preserves_intent: false, basis: '원 의도를 축소함' },
    });
    // First distortion reject throws; second parks.
    await expect(
      recordTurn(repo, {
        workItemId: wiId,
        payload: { dimension: critDim('d-intent'), question: distorting },
      }),
    ).rejects.toThrow(/distort\/shrink\/bias-inject/);
    const parked = await recordTurn(repo, {
      workItemId: wiId,
      payload: { dimension: critDim('d-intent'), question: distorting },
    });
    expect(parked.exit.reason).toBe('parked');
    // recordFireRejection surfaces the unresolved set (all unresolved dims, not critical-only).
    const surfaced = await recordFireRejection(repo, wiId);
    expect(surfaced.unresolved).toContain('d-intent');
  });

  test('a successful fired turn clears the parked exit.reason (park is a transient surface)', async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
    await recordTurn(repo, {
      workItemId: wiId,
      payload: { dimension: critDim('d-open'), question: goodQuestion() },
    });
    await expect(
      recordTurn(repo, {
        workItemId: wiId,
        payload: { dimension: critDim('d-open'), question: badQuestion() },
      }),
    ).rejects.toThrow();
    const parked = await recordTurn(repo, {
      workItemId: wiId,
      payload: { dimension: critDim('d-open'), question: badQuestion() },
    });
    expect(parked.exit.reason).toBe('parked');
    // A good fired turn recomputes exit.reason on the normal write path → parked cleared.
    const recovered = await recordTurn(repo, {
      workItemId: wiId,
      payload: { dimension: critDim('d-open'), question: goodQuestion({ text: 'q-recover?' }) },
    });
    expect(recovered.exit.reason).not.toBe('parked');
  });
});

// ── Constraint-2 (iv): internal turns do not pollute fired-turn accounting ────

describe('ac-5 constraint-2 turn-marker non-pollution', () => {
  test('internal turn leaves questions_asked and the novelty-dry counter unchanged (legacy-absent=fired)', async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
    // Fired round 1 with no novelty (novelty=false) — one dry fired round (K=2 not yet reached).
    const s1 = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: critDim('d-crit'),
        question: goodQuestion({ novelty: false, text: 'q1?' }),
      },
    });
    expect(s1.exit.questions_asked).toBe(1);
    expect(s1.exit.reason).not.toBe('diminishing_returns');

    // INTERNAL round with novelty=false — must NOT bump questions_asked NOR the novelty-dry counter.
    const s2 = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: critDim('d-crit'),
        question: goodQuestion({ novelty: false, text: 'q2-internal?', turn_kind: 'internal' }),
      },
    });
    expect(s2.exit.questions_asked).toBe(1); // unchanged — internal not counted
    expect(s2.questions.length).toBe(2); // but the turn WAS recorded
    expect(s2.exit.reason).not.toBe('diminishing_returns'); // dry counter still 1 (internal filtered)

    // Fired round 2 with novelty=false — NOW two fired dry rounds → angle-dry (K=2) fires.
    const s3 = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: critDim('d-crit'),
        question: goodQuestion({ novelty: false, text: 'q3?' }),
      },
    });
    expect(s3.exit.questions_asked).toBe(2); // only fired turns counted
    expect(s3.exit.reason).toBe('diminishing_returns');
  });

  test('assumption-ratio denominator counts fired turns only (interviewReadinessGate)', () => {
    const base: InterviewState = {
      schema_version: '0.1.0',
      work_item_id: 'wi_denominator',
      status: 'active',
      started_at: '2026-07-24T00:00:00.000Z',
      updated_at: '2026-07-24T00:00:00.000Z',
      dimensions: [],
      readiness: { score: 1, threshold: 0.7, critical_unresolved: [], gate: 'blocked' },
      questions: [],
      assumptions: [
        { statement: 'a', label: 'hypothesis', confidence: 'medium', because_no_answer_to: 'q001' },
      ],
      premortem: [],
      exit: {
        reason: 'readiness_met',
        closure_mode: 'ledger_only',
        question_cap: 8,
        questions_asked: 1,
      },
    };
    const q = (id: string, turn_kind?: 'internal') => ({
      id,
      asked_at: '2026-07-24T00:00:00.000Z',
      dimension: 'd',
      question: 'q?',
      why_matters: 'm',
      info_gain_estimate: 'high' as const,
      self_answer_attempts: [],
      ...(turn_kind ? { turn_kind } : {}),
    });
    // One fired question → denominator 1 → assumption_ratio 1.
    const firedOnly: InterviewState = { ...base, questions: [q('q001')] };
    // Add an internal question → questions.length 2 but fired denominator STILL 1.
    const withInternal: InterviewState = { ...base, questions: [q('q001'), q('q002', 'internal')] };
    // Same denominator ⇒ same deterministic floor ⇒ same capped readiness ⇒ same gate reasons.
    expect(interviewReadinessGate(withInternal)).toEqual(interviewReadinessGate(firedOnly));
  });
});

// ── Part A (v): verbatim anchor is driver-filled and scan-exempt ─────────────

describe('ac-3 verbatim source anchor (driver-filled, scan-exempt)', () => {
  test('anchor filled from the Record with §/ADR/wi_ text does not false-trip the leak scan', async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
    // A clean question surface (passes layer-1); the anchor carries the raw internal-vocab tokens.
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: { dimension: critDim('d-anchor'), question: goodQuestion() },
    });
    const q = state.questions[0];
    expect(q?.source_anchor).toBe(SOURCE_REQUEST); // driver-filled verbatim from source_request
    expect(q?.source_anchor).toContain('wi_260723lny'); // §/ADR/wi_ survived without a leak reject
  });
});

// ── Part B: post-answer intent summary (prism-safe) ──────────────────────────

describe('ac-4 post-answer intent summary', () => {
  test('a user answer returns a confirmed/open intent summary; a question-only turn does not', async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
    // Question-only turn (no answer) → no summary.
    const noAnswer = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: {
          id: 'd1',
          critical: false,
          state: 'partial',
          ambiguity: 0.5,
          notes: '열린 항목',
        },
        question: goodQuestion(),
      },
    });
    expect(noAnswer.intent_summary).toBeUndefined();

    // User answer resolving a dimension → summary with the resolved point confirmed.
    const answered = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: {
          id: 'd2',
          critical: false,
          state: 'resolved',
          ambiguity: 0.1,
          notes: '정수 0..100',
        },
        question: goodQuestion({ text: '범위는?' }),
        answer: { text: '정수 0..100', kind: 'user' },
      },
    });
    expect(answered.intent_summary).toBeDefined();
    expect(answered.intent_summary?.confirmed).toContain('정수 0..100');
    expect(answered.intent_summary?.open).toContain('열린 항목');
  });
});

// ── Part B (vi): finalize stays callable without per-answer summaries ─────────

describe('ac-4 finalize prism-safety', () => {
  test('(vi) finalizeInterview is callable with a fixed payload and NO per-answer summaries', async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: critDim('d-shape', 'resolved'),
        question: goodQuestion(),
        answer: { text: '정수 0..100', kind: 'user' },
        readiness_score: 0.9,
      },
    });
    // Same shape prism's finalizeFromDesignDoc uses: one finalize payload, no summaries.
    const result = await finalizeInterview(repo, {
      workItemId: wiId,
      payload: {
        goal: 'returns integer score 0..100 for a password',
        in_scope: ['POST /password-strength'],
        out_of_scope: ['storage'],
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
        user_confirmation: { confirmed: true, statement: '네, 이 의도가 맞습니다' },
      },
    });
    expect(result.status).toBe('finalized');
  });
});
