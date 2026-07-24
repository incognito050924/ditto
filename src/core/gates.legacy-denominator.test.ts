import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveClosureMode, deterministicFloor, interviewReadinessGate } from '~/core/gates';
import { collectIntentQualityReport, defaultIntentQualityDeps } from '~/core/intent-quality-doctor';
import { type RecordTurnPayload, recordTurn, startInterview } from '~/core/interview-driver';
import { InterviewStore } from '~/core/interview-store';
import { WorkItemStore } from '~/core/work-item-store';
import { type InterviewState, interviewState } from '~/schemas/interview-state';

// ─────────────────────────────────────────────────────────────────────────────
// Named regression oracles pinning the questions[]-derived accounting invariant
// under mixed / absent turn_kind markers (wi_260723lny, ac-5 + ac-8). The impl
// (gates.ts:81-93 assumption-ratio denominator, interview-driver.ts firedTurnCount /
// questions_asked / novelty-dry) is already landed; these tests PIN it green. A red
// here is a real regression — do not weaken the oracle.
// ─────────────────────────────────────────────────────────────────────────────

const ISO = '2026-07-24T00:00:00.000Z';

function baseState(over: Partial<InterviewState> = {}): InterviewState {
  return {
    schema_version: '0.1.0',
    work_item_id: 'wi_legacydenom',
    status: 'active',
    started_at: ISO,
    updated_at: ISO,
    dimensions: [],
    readiness: { score: 1, threshold: 0.7, critical_unresolved: [], gate: 'blocked' },
    questions: [],
    assumptions: [],
    premortem: [],
    exit: {
      reason: 'readiness_met',
      closure_mode: 'ledger_only',
      question_cap: 8,
      questions_asked: 0,
    },
    ...over,
  };
}

function q(id: string, turn_kind?: 'fired' | 'internal') {
  return {
    id,
    asked_at: ISO,
    dimension: 'd',
    question: 'q?',
    why_matters: 'm',
    info_gain_estimate: 'high' as const,
    self_answer_attempts: [],
    ...(turn_kind ? { turn_kind } : {}),
  };
}

function assumption(qid: string) {
  return {
    statement: 'a',
    label: 'hypothesis' as const,
    confidence: 'medium' as const,
    because_no_answer_to: qid,
  };
}

// ── pure gate oracles (no repo) ──────────────────────────────────────────────
describe('gates legacy-denominator oracles (pure)', () => {
  // Oracle 1: gates.ts legacy denominator (src/core/gates.ts:81-93). A legacy
  // interview-state with NO turn_kind markers uses assumption_ratio denominator =
  // questions.length (marker-absent = fired), i.e. the pre-marker semantics unchanged.
  test('oracle-1: marker-absent assumption_ratio denominator = questions.length (pre-marker unchanged)', () => {
    const questions = ['q001', 'q002', 'q003', 'q004', 'q005'].map((id) => q(id)); // no markers
    const state = baseState({
      questions,
      assumptions: [assumption('q001')], // 1 assumption
      readiness: { score: 1, threshold: 0.995, critical_unresolved: [], gate: 'blocked' },
    });
    const result = interviewReadinessGate(state);
    // Reproduce the exact capped readiness the gate should report IF its denominator ==
    // questions.length (pre-marker semantics), via the exported deterministicFloor. The gate's
    // own reason string must carry that value → its denominator is questions.length (= 5).
    const floor = deterministicFloor({
      open_required_sections: 0,
      conflicting: 0,
      assumption_ratio: 1 / questions.length,
    });
    const capped = Math.min(1, 1 - floor);
    expect(result.pass).toBe(false);
    expect(result.reasons.join(' ')).toContain(capped.toFixed(2));
    // marker-absent ≡ all-'fired': stamping every legacy turn as 'fired' yields identical output.
    const allFired: InterviewState = {
      ...state,
      questions: questions.map((qq) => ({ ...qq, turn_kind: 'fired' as const })),
    };
    expect(interviewReadinessGate(allFired)).toEqual(result);
  });

  // Oracle 4: ac-5 legacy-mixed contract. Cap JUDGMENT semantics (deriveClosureMode over
  // cap_reached) and the readiness ambiguity denominator (questions[] meaning) stay invariant
  // when legacy (marker-absent) turns mix with marked turns; exit.reason 'cap_reached' parses;
  // question_cap stays required.
  test('oracle-4: legacy-mixed — cap judgment + questions[] denominator + cap_reached parse invariant', () => {
    // cap JUDGMENT semantics unchanged: blocked-gate cap → ledger_only, passing-gate cap → mutual.
    expect(deriveClosureMode('cap_reached', false)).toBe('ledger_only');
    expect(deriveClosureMode('cap_reached', true)).toBe('mutual_agreement');
    // exit.reason 'cap_reached' still PARSES (legacy on-disk state).
    const capParse = interviewState.safeParse(
      baseState({
        exit: {
          reason: 'cap_reached',
          closure_mode: 'ledger_only',
          question_cap: 8,
          questions_asked: 0,
        },
      }),
    );
    expect(capParse.success).toBe(true);
    // question_cap is REQUIRED (omission fails closed).
    const raw: Record<string, unknown> = { ...baseState() };
    raw.exit = { reason: 'cap_reached', closure_mode: 'ledger_only', questions_asked: 0 };
    expect(interviewState.safeParse(raw).success).toBe(false);
    // Legacy turn mixed with a 'fired'-marked turn → denominator 2, identical to two marker-absent
    // turns (readiness ambiguity-lower-bound denominator invariant).
    const mixed = baseState({
      questions: [q('q001'), q('q002', 'fired')],
      assumptions: [assumption('q001')],
    });
    const allAbsent = baseState({
      questions: [q('q001'), q('q002')],
      assumptions: [assumption('q001')],
    });
    expect(interviewReadinessGate(mixed)).toEqual(interviewReadinessGate(allAbsent));
  });

  // Oracle 8: legacy marker-absent = fired polarity. A no-marker state and an all-'fired'-marker
  // state produce identical accounting at the readiness (denominator) point — the fail-open-to-
  // legacy-semantics guarantee.
  test('oracle-8: no-marker state ≡ all-fired state (marker-absent = fired polarity)', () => {
    const ids = ['q001', 'q002', 'q003'];
    const noMarker = baseState({
      questions: ids.map((id) => q(id)),
      assumptions: [assumption('q001'), assumption('q002')],
    });
    const allFired = baseState({
      questions: ids.map((id) => q(id, 'fired')),
      assumptions: [assumption('q001'), assumption('q002')],
    });
    expect(interviewReadinessGate(noMarker)).toEqual(interviewReadinessGate(allFired));
  });
});

// ── driver + D4 accounting oracles (repo-backed) ─────────────────────────────
describe('driver + D4 accounting oracles (mixed markers)', () => {
  let repo: string;
  let wiId: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-legacydenom-'));
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
  function critDim(id: string, state: 'unknown' | 'partial' | 'resolved' = 'partial') {
    return { id, critical: true, state, ambiguity: 0.5, notes: '' } as const;
  }

  // Oracle 5: novelty dry-counter mixed-marker invariant (interview-driver.ts ~751-759). An
  // internal turn does NOT advance the novelty-dry counter; mixing it in leaves the dry-close
  // accounting identical to fired-only (diminishing_returns still fires at the 2nd FIRED dry round).
  test('oracle-5: internal turn does not advance the novelty-dry counter (dry-close = fired-only)', async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
    const s1 = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: critDim('d-crit'),
        question: goodQuestion({ novelty: false, text: 'q1?' }),
      },
    });
    expect(s1.exit.reason).not.toBe('diminishing_returns'); // 1 fired dry round (K=2 not reached)

    const s2 = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: critDim('d-crit'),
        question: goodQuestion({ novelty: false, text: 'q2-internal?', turn_kind: 'internal' }),
      },
    });
    // Internal dry turn does NOT advance the counter — still would-be 1, so NO early close.
    expect(s2.exit.reason).not.toBe('diminishing_returns');
    expect(s2.questions.length).toBe(2); // but the turn WAS recorded

    const s3 = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: critDim('d-crit'),
        question: goodQuestion({ novelty: false, text: 'q3?' }),
      },
    });
    expect(s3.exit.reason).toBe('diminishing_returns'); // 2nd FIRED dry round → angle-dry (K=2)
  });

  // Oracle 6: questions_asked mixed-marker invariant (interview-driver.ts ~726-730). questions_asked
  // counts FIRED turns only; an internal turn does not increment it; a marker-absent legacy turn
  // counts as fired.
  test('oracle-6: questions_asked counts fired turns only; marker-absent = fired', async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
    const s1 = await recordTurn(repo, {
      workItemId: wiId,
      payload: { dimension: critDim('d1'), question: goodQuestion({ text: 'q1?' }) }, // marker-absent = fired
    });
    expect(s1.exit.questions_asked).toBe(1);

    const s2 = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: critDim('d1'),
        question: goodQuestion({ text: 'q2-internal?', turn_kind: 'internal' }),
      },
    });
    expect(s2.exit.questions_asked).toBe(1); // internal did not increment
    expect(s2.questions.length).toBe(2); // but was recorded

    const s3 = await recordTurn(repo, {
      workItemId: wiId,
      payload: { dimension: critDim('d1'), question: goodQuestion({ text: 'q3?' }) },
    });
    expect(s3.exit.questions_asked).toBe(2); // only fired turns counted
  });

  // Oracle 7: intent-quality-doctor D4 invariant (intent-quality-doctor.ts:152 reads
  // exit.questions_asked). D4's questions_asked-derived value is invariant under added internal
  // turns, because questions_asked already excludes internal turns. Driven end-to-end: two WIs,
  // one fired-only, one fired+internal — both D4 measures equal.
  test('oracle-7: D4 questions_asked measure invariant under added internal turns', async () => {
    // WI A — fired only.
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
    await recordTurn(repo, {
      workItemId: wiId,
      payload: { dimension: critDim('d1'), question: goodQuestion({ text: 'qA?' }) },
    });

    // WI B — one fired turn, then an internal turn.
    const wiB = (
      await new WorkItemStore(repo).create({
        title: 'second work item',
        source_request: '두 번째 항목',
        goal: 'second goal',
        acceptance_criteria: [
          { id: 'ac-1', statement: 'TBD', verdict: 'unverified', evidence: [] },
        ],
      })
    ).id;
    await startInterview(repo, { workItemId: wiB, questionCap: 8 });
    await recordTurn(repo, {
      workItemId: wiB,
      payload: { dimension: critDim('d1'), question: goodQuestion({ text: 'qB?' }) },
    });
    await recordTurn(repo, {
      workItemId: wiB,
      payload: {
        dimension: critDim('d1'),
        question: goodQuestion({ text: 'qB-internal?', turn_kind: 'internal' }),
      },
    });

    const stateB = await new InterviewStore(repo).get(wiB);
    expect(stateB.questions.length).toBe(2); // internal turn WAS recorded
    expect(stateB.exit.questions_asked).toBe(1); // but excluded from the D4 measure

    const report = await collectIntentQualityReport(defaultIntentQualityDeps(repo));
    const rowA = report.rows.find((r) => r.work_item_id === wiId);
    const rowB = report.rows.find((r) => r.work_item_id === wiB);
    expect(rowA?.questions_asked).toBe(1);
    expect(rowB?.questions_asked).toBe(1); // same D4 measure despite the extra internal turn
  });
});
