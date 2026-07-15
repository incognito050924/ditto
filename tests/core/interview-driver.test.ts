import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutopilotStore } from '~/core/autopilot-store';
import { CoverageStore } from '~/core/coverage-store';
import { highRiskAssumption } from '~/core/gates';
import { IntentStore } from '~/core/intent-store';
import {
  type FinalizePayload,
  acknowledgeIntentDissent,
  checkReadiness,
  finalizeInterview,
  guardBranchEdges,
  orderPendingBranchWork,
  projectInterviewDimensions,
  recordTurn,
  startInterview,
} from '~/core/interview-driver';
import { InterviewStore } from '~/core/interview-store';
import type { OpponentSeamConfig } from '~/core/prism/opponent';
import { WorkItemStore } from '~/core/work-item-store';
import { interviewQuestion } from '~/schemas/interview-state';

const BARE_POLICY: OpponentSeamConfig['policy'] = {
  producer: 'current-host',
  opponent_preferred: 'codex',
  opponent_fallback: [],
  synthesizer: 'claude-opus',
};
function opponentConfig(over: Partial<OpponentSeamConfig>): OpponentSeamConfig {
  return {
    policy: BARE_POLICY,
    currentHost: 'claude-code',
    isAvailable: () => ({ available: true }),
    delegate: async () => null,
    intent: 'original intent',
    ...over,
  };
}

let repo: string;
let wiId: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-iv-'));
  const wi = await new WorkItemStore(repo).create({
    title: 'password strength endpoint',
    source_request: 'add a /password-strength endpoint',
    goal: 'returns a 0-100 score for a password',
    acceptance_criteria: [
      {
        id: 'ac-1',
        statement: 'TBD — derive observable criteria during interview/planning',
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

describe('startInterview', () => {
  test('creates interview-state.json with default threshold and cap', async () => {
    const state = await startInterview(repo, { workItemId: wiId });
    expect(state.work_item_id).toBe(wiId);
    expect(state.status).toBe('active');
    expect(state.readiness.threshold).toBe(0.7);
    expect(state.exit.question_cap).toBe(8);
    expect(state.questions.length).toBe(0);
    expect(state.dimensions.length).toBe(0);
    expect(await new InterviewStore(repo).exists(wiId)).toBe(true);
  });

  test('honors explicit threshold and questionCap', async () => {
    const state = await startInterview(repo, { workItemId: wiId, threshold: 0.9, questionCap: 3 });
    expect(state.readiness.threshold).toBe(0.9);
    expect(state.exit.question_cap).toBe(3);
  });
});

describe('recordTurn', () => {
  beforeEach(async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 3 });
  });

  test('appends a question + upserts a new dimension', async () => {
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: {
          id: 'd-score-formula',
          critical: true,
          state: 'partial',
          ambiguity: 0.6,
          notes: '',
        },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'How is the score computed?',
          why_matters: 'Determines the response shape and edge cases.',
          info_gain_estimate: 'high',
        },
      },
    });
    expect(state.questions.length).toBe(1);
    expect(state.dimensions.length).toBe(1);
    expect(state.questions[0]?.dimension).toBe('d-score-formula');
    expect(state.exit.questions_asked).toBe(1);
    expect(state.readiness.critical_unresolved).toContain('d-score-formula');
  });

  test('re-upserts an existing dimension (id collision = update, not duplicate)', async () => {
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd1', critical: false, state: 'partial', ambiguity: 0.5, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q1?',
          why_matters: 'because',
          info_gain_estimate: 'medium',
        },
      },
    });
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd1', critical: false, state: 'resolved', ambiguity: 0.1, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q2?',
          why_matters: 'follow-up',
          info_gain_estimate: 'low',
        },
        answer: { text: 'use bcrypt', kind: 'user' },
      },
    });
    expect(state.dimensions.length).toBe(1);
    expect(state.dimensions[0]?.state).toBe('resolved');
    expect(state.dimensions[0]?.resolved_by).toContain('q002');
    expect(state.questions.length).toBe(2);
  });

  test('assumption answer is recorded in assumptions[] ledger', async () => {
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd1', critical: false, state: 'partial', ambiguity: 0.4, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q1?',
          why_matters: 'unknown',
          info_gain_estimate: 'medium',
        },
        answer: { text: 'assume bcrypt-12', kind: 'assumption' },
      },
    });
    expect(state.assumptions.length).toBe(1);
    expect(state.assumptions[0]?.statement).toBe('assume bcrypt-12');
    expect(state.assumptions[0]?.because_no_answer_to).toBe('q001');
  });

  // Soundness: an agent-guessed (assumption-kind, not user-delegated) answer must
  // not be able to close a CRITICAL dimension as resolved — otherwise the readiness
  // gate cannot tell an agent's guess apart from a user's answer.
  test('agent-guess assumption cannot resolve a CRITICAL dimension', async () => {
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-crit', critical: true, state: 'resolved', ambiguity: 0.2, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'critical?',
          why_matters: 'load-bearing',
          info_gain_estimate: 'high',
        },
        answer: { text: 'agent guesses bcrypt-12', kind: 'assumption' },
      },
    });
    // the dimension is NOT closed by an agent guess …
    expect(state.dimensions[0]?.state).not.toBe('resolved');
    // … so the readiness gate still sees it as unresolved.
    expect(state.readiness.critical_unresolved).toContain('d-crit');
    // it is still recorded as an assumption in the ledger (intent preserved).
    expect(state.assumptions.length).toBe(1);
  });

  test('user-delegated assumption MAY resolve a CRITICAL dimension', async () => {
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-crit', critical: true, state: 'resolved', ambiguity: 0.2, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'critical?',
          why_matters: 'load-bearing',
          info_gain_estimate: 'high',
        },
        answer: { text: 'user said: you decide', kind: 'assumption', delegated: true },
      },
    });
    expect(state.dimensions[0]?.state).toBe('resolved');
    expect(state.readiness.critical_unresolved).not.toContain('d-crit');
  });

  test('agent-guess assumption may still resolve a NON-critical dimension', async () => {
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-min', critical: false, state: 'resolved', ambiguity: 0.2, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'minor?',
          why_matters: 'cosmetic',
          info_gain_estimate: 'low',
        },
        answer: { text: 'assume default', kind: 'assumption' },
      },
    });
    expect(state.dimensions[0]?.state).toBe('resolved');
  });

  test('record-turn with marginal_gain preserves it on the appended question', async () => {
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd1', critical: false, state: 'partial', ambiguity: 0.5, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q1?',
          why_matters: 'because',
          info_gain_estimate: 'low',
          marginal_gain: 0.05,
        },
      },
    });
    expect(state.questions[0]?.marginal_gain).toBe(0.05);
  });

  test('record-turn without marginal_gain parses + works (backward compatible)', async () => {
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd1', critical: false, state: 'partial', ambiguity: 0.5, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q1?',
          why_matters: 'because',
          info_gain_estimate: 'medium',
        },
      },
    });
    expect(state.questions.length).toBe(1);
    expect(state.questions[0]?.marginal_gain).toBeUndefined();
  });

  test('exit.reason flips to cap_reached when questions_asked >= cap', async () => {
    for (let i = 0; i < 3; i++) {
      await recordTurn(repo, {
        workItemId: wiId,
        payload: {
          dimension: { id: `d${i}`, critical: false, state: 'partial', ambiguity: 0.5, notes: '' },
          question: {
            user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
            recommended_answer: '추천 답변 예시입니다.',
            text: `q${i}?`,
            why_matters: 'x',
            info_gain_estimate: 'medium',
          },
        },
      });
    }
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.exit.questions_asked).toBe(3);
    expect(state.exit.reason).toBe('cap_reached');
  });

  test('marginal_gain below dry floor + gate blocked + non-cap → exit.reason=diminishing_returns', async () => {
    // single turn, cap=3 so not cap_reached; critical dim unresolved → gate blocked;
    // marginal_gain 0.02 < dry floor → dry round.
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-crit', critical: true, state: 'partial', ambiguity: 0.5, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q?',
          why_matters: 'x',
          info_gain_estimate: 'low',
          marginal_gain: 0.02,
        },
      },
    });
    expect(state.exit.questions_asked).toBe(1);
    expect(state.readiness.gate).toBe('blocked');
    expect(state.exit.reason).toBe('diminishing_returns');
    // dry + blocked stays ledger_only (deriveClosureMode unchanged).
    expect(state.exit.closure_mode).toBe('ledger_only');
  });

  test('cap_reached takes precedence over dry (both true on the same turn)', async () => {
    // questionCap=3: first 2 turns non-terminal, 3rd hits cap AND carries a dry-floor
    // marginal_gain. cap_reached must win.
    for (let i = 0; i < 2; i++) {
      await recordTurn(repo, {
        workItemId: wiId,
        payload: {
          dimension: { id: `d${i}`, critical: true, state: 'partial', ambiguity: 0.5, notes: '' },
          question: {
            user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
            recommended_answer: '추천 답변 예시입니다.',
            text: `q${i}?`,
            why_matters: 'x',
            info_gain_estimate: 'low',
          },
        },
      });
    }
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd2', critical: true, state: 'partial', ambiguity: 0.5, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q2?',
          why_matters: 'x',
          info_gain_estimate: 'low',
          marginal_gain: 0.01,
        },
      },
    });
    expect(state.exit.questions_asked).toBe(3);
    expect(state.exit.reason).toBe('cap_reached');
  });

  test('marginal_gain at/above dry floor does NOT trigger diminishing_returns', async () => {
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-crit', critical: true, state: 'partial', ambiguity: 0.5, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q?',
          why_matters: 'x',
          info_gain_estimate: 'high',
          marginal_gain: 0.5,
        },
      },
    });
    expect(state.exit.reason).not.toBe('diminishing_returns');
  });

  // AC4 (8번): the raised dry floor closes low-value tail rounds earlier. 0.08 was
  // above the old 0.05 floor (the round kept going) but is below the raised floor,
  // so it now terminates as diminishing_returns — without touching question quality.
  test('a marginal_gain between the old and new dry floor now closes the tail round (AC4)', async () => {
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-crit', critical: true, state: 'partial', ambiguity: 0.5, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q?',
          why_matters: 'x',
          info_gain_estimate: 'low',
          marginal_gain: 0.08,
        },
      },
    });
    expect(state.readiness.gate).toBe('blocked');
    expect(state.exit.reason).toBe('diminishing_returns');
  });
});

describe('startInterview generators lever (ac-4)', () => {
  // The fan-out count is a SKILL-loop lever (read by the deep-interview driver
  // agent), not a persisted InterviewState field — the state schema is owned
  // elsewhere and out of scope. The driver entry contract is: startInterview
  // accepts `generators` on StartInput (default 1 = serial-equivalent) and
  // returns the resolved value so the CLI/SKILL can surface it.
  test('honors explicit generators count on StartInput', async () => {
    const result = await startInterview(repo, { workItemId: wiId, generators: 3 });
    expect(result.generators).toBe(3);
  });

  test('defaults generators to 1 when omitted (serial-equivalent)', async () => {
    const result = await startInterview(repo, { workItemId: wiId });
    expect(result.generators).toBe(1);
  });
});

// 기제 C (wi_260706n4w ac-4/ac-6): user-intent far-field categories seed as
// deep-interview DIMENSIONS (closeable cov-dim-*, not permanently-open cov-cat-*).
// Opt-in on StartInput (default false → existing callers unchanged, ac-6); the
// CLI `deep-interview start` seam turns it on — mirroring the coverage-loop
// `seedCategories` engine-default-false / CLI-seam-on precedent.
describe('startInterview seeds user-intent dimensions (기제 C, wi_260706n4w)', () => {
  test('seedUserIntentDimensions:true seeds one non-critical unknown dimension per floor user-intent category, notes = lens', async () => {
    const state = await startInterview(repo, { workItemId: wiId, seedUserIntentDimensions: true });
    const ids = state.dimensions.map((d) => d.id);
    // floor user-intent categories (coverage-taxonomy.ts): authorization-model + regulatory.
    expect(ids).toContain('authorization-model');
    expect(ids).toContain('regulatory');
    // code-verify categories are NOT seeded as interview dimensions.
    expect(ids).not.toContain('injection');
    for (const d of state.dimensions) {
      // fail-open (ac-4): non-critical + unknown — an unanswered seed never
      // hard-blocks readiness; it stays an OPEN cov-dim node in the sweep.
      expect(d.critical).toBe(false);
      expect(d.state).toBe('unknown');
      // the probing question rides notes → becomes the cov-dim label at projection.
      expect(d.notes.length).toBeGreaterThan(0);
    }
    // persisted on disk, not just returned.
    const onDisk = await new InterviewStore(repo).get(wiId);
    expect(onDisk.dimensions.map((d) => d.id)).toEqual(ids);
  });

  test('seeding respects the RESOLVED taxonomy (tier-② dispositions re-route), not the raw floor', async () => {
    // re-route `auditing` (floor: code-verify) to user-intent via tier-② config.
    await mkdir(join(repo, '.ditto'), { recursive: true });
    await writeFile(
      join(repo, '.ditto', 'coverage-taxonomy.json'),
      JSON.stringify({ dispositions: { auditing: 'user-intent' } }),
      'utf8',
    );
    const state = await startInterview(repo, { workItemId: wiId, seedUserIntentDimensions: true });
    const ids = state.dimensions.map((d) => d.id);
    expect(ids).toContain('auditing');
    expect(ids).toContain('authorization-model');
    expect(ids).toContain('regulatory');
  });

  test('seeded dims never block the readiness gate (fail-open, ac-4): normal flow still finalizes with seeds unanswered', async () => {
    await startInterview(repo, { workItemId: wiId, seedUserIntentDimensions: true });
    const r0 = await checkReadiness(repo, wiId);
    // non-critical seeds are absent from critical_unresolved.
    expect(r0.critical_unresolved).toEqual([]);
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-shape', critical: true, state: 'resolved', ambiguity: 0.05, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'shape?',
          why_matters: 'response',
          info_gain_estimate: 'high',
        },
        answer: { text: 'integer', kind: 'user' },
        readiness_score: 0.85,
      },
    });
    const result = await finalizeInterview(repo, {
      workItemId: wiId,
      payload: {
        goal: 'g',
        in_scope: [],
        out_of_scope: [],
        acceptance_criteria: [
          {
            id: 'ac-1',
            statement: 'returns 200',
            verdict: 'unverified',
            evidence: [],
            evidence_required: [],
          },
        ],
        unknowns: [],
        follow_up_candidates: [],
        question_policy: 'ask_only_if_user_only_can_answer',
        risk: { non_local: false, irreversible: false, unaudited: false },
        user_confirmation: { confirmed: true, statement: '맞아요' },
      },
    });
    expect(result.status).toBe('finalized');
  });
});

describe('checkReadiness', () => {
  beforeEach(async () => {
    await startInterview(repo, { workItemId: wiId });
  });

  test('BLOCKED when a critical dimension is unresolved', async () => {
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: {
          id: 'd-critical',
          critical: true,
          state: 'partial',
          ambiguity: 0.6,
          notes: '',
        },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'critical?',
          why_matters: 'load-bearing',
          info_gain_estimate: 'high',
        },
        readiness_score: 0.95,
      },
    });
    const r = await checkReadiness(repo, wiId);
    expect(r.gate.pass).toBe(false);
    expect(r.critical_unresolved).toContain('d-critical');
  });

  test('READY when criticals resolved and score >= threshold (after floor cap)', async () => {
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: {
          id: 'd-critical',
          critical: true,
          state: 'resolved',
          ambiguity: 0.05,
          notes: '',
        },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'critical?',
          why_matters: 'load-bearing',
          info_gain_estimate: 'high',
        },
        answer: { text: 'agreed on 0..100 integer', kind: 'user' },
        readiness_score: 0.85,
      },
    });
    const r = await checkReadiness(repo, wiId);
    expect(r.gate.pass).toBe(true);
    expect(r.critical_unresolved.length).toBe(0);
  });
});

describe('finalizeInterview', () => {
  test('not_ready when readiness gate fails', async () => {
    await startInterview(repo, { workItemId: wiId });
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-x', critical: true, state: 'partial', ambiguity: 0.4, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q?',
          why_matters: 'm',
          info_gain_estimate: 'high',
        },
      },
    });
    const result = await finalizeInterview(repo, {
      workItemId: wiId,
      payload: {
        goal: 'g',
        in_scope: [],
        out_of_scope: [],
        acceptance_criteria: [
          {
            id: 'ac-1',
            statement: 'returns score 0..100',
            verdict: 'unverified',
            evidence: [],
            evidence_required: [],
          },
        ],
        unknowns: [],
        follow_up_candidates: [],
        question_policy: 'ask_only_if_user_only_can_answer',
        risk: { non_local: false, irreversible: false, unaudited: false },
        user_confirmation: { confirmed: true, statement: '맞아요' },
      },
    });
    expect(result.status).toBe('not_ready');
    expect(await new IntentStore(repo).exists(wiId)).toBe(false);
    expect(await new AutopilotStore(repo).exists(wiId)).toBe(false);
  });

  test('ready → writes intent.json, mirrors AC into work item, bootstraps autopilot (§AC-2 + AC-3)', async () => {
    await startInterview(repo, { workItemId: wiId });
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-shape', critical: true, state: 'resolved', ambiguity: 0.05, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'shape?',
          why_matters: 'response',
          info_gain_estimate: 'high',
        },
        answer: { text: 'integer 0..100', kind: 'user' },
        readiness_score: 0.85,
      },
    });
    const result = await finalizeInterview(repo, {
      workItemId: wiId,
      payload: {
        goal: 'returns integer score 0..100 for a password',
        in_scope: ['POST /password-strength', 'JSON response'],
        out_of_scope: ['storage', 'auth'],
        acceptance_criteria: [
          {
            id: 'ac-1',
            statement: 'returns integer 0..100',
            verdict: 'unverified',
            evidence: [],
            evidence_required: ['test'],
          },
          {
            id: 'ac-2',
            statement: 'rejects empty input with status 400',
            verdict: 'unverified',
            evidence: [],
            evidence_required: ['test'],
          },
        ],
        unknowns: [],
        follow_up_candidates: ['rate limiting'],
        question_policy: 'ask_only_if_user_only_can_answer',
        risk: { non_local: false, irreversible: false, unaudited: false },
        user_confirmation: { confirmed: true, statement: '네, 이 의도가 맞습니다' },
      },
    });
    expect(result.status).toBe('finalized');
    if (result.status === 'finalized') {
      expect(await new IntentStore(repo).exists(wiId)).toBe(true);
      expect(await new AutopilotStore(repo).exists(wiId)).toBe(true);
      // AC mirrored into work item.
      const workItem = await new WorkItemStore(repo).get(wiId);
      expect(workItem.acceptance_criteria.map((ac) => ac.id)).toEqual(['ac-1', 'ac-2']);
      expect(workItem.goal).toBe('returns integer score 0..100 for a password');
      // Autopilot graph aligned with intent AC (design → implement → verify per AC).
      expect(result.autopilot.work_item_id).toBe(wiId);
      expect(result.autopilot.root_goal).toBe('returns integer score 0..100 for a password');
      expect(result.autopilot.nodes.length).toBeGreaterThan(0);
      // safeDefaultable risk → approval_gate.status='not_required'.
      expect(result.autopilot.approval_gate.status).toBe('not_required');
    }
  });

  test('idempotent: second finalize re-writes intent + autopilot (fresh autopilot_id)', async () => {
    await startInterview(repo, { workItemId: wiId });
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-shape', critical: true, state: 'resolved', ambiguity: 0.05, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'shape?',
          why_matters: 'response',
          info_gain_estimate: 'high',
        },
        answer: { text: 'integer', kind: 'user' },
        readiness_score: 0.85,
      },
    });
    const payload = {
      goal: 'g',
      in_scope: [],
      out_of_scope: [],
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 'returns 200',
          verdict: 'unverified' as const,
          evidence: [],
          evidence_required: [],
        },
      ],
      unknowns: [],
      follow_up_candidates: [],
      question_policy: 'ask_only_if_user_only_can_answer' as const,
      risk: { non_local: false, irreversible: false, unaudited: false },
      user_confirmation: { confirmed: true, statement: '확인했습니다' },
    };
    const first = await finalizeInterview(repo, { workItemId: wiId, payload });
    const second = await finalizeInterview(repo, { workItemId: wiId, payload });
    expect(first.status).toBe('finalized');
    expect(second.status).toBe('finalized');
    if (first.status === 'finalized' && second.status === 'finalized') {
      // Same structure, different autopilot_id (generateId is random).
      expect(second.autopilot.autopilot_id).not.toBe(first.autopilot.autopilot_id);
      expect(second.autopilot.nodes.map((n) => n.id)).toEqual(
        first.autopilot.nodes.map((n) => n.id),
      );
    }
  });

  // 4b: 축1 종료 = readiness(1차) ∧ user confirmation(2차). The readiness gate
  // passing is NOT enough — without the user confirmation finalize must fail closed
  // and write no artifact. (Old behavior: gate-pass alone → finalized.)
  async function driveToReady(): Promise<void> {
    await startInterview(repo, { workItemId: wiId });
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-shape', critical: true, state: 'resolved', ambiguity: 0.05, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'shape?',
          why_matters: 'response',
          info_gain_estimate: 'high',
        },
        answer: { text: 'integer', kind: 'user' },
        readiness_score: 0.85,
      },
    });
  }
  const readyPayload = (over: Partial<FinalizePayload>): FinalizePayload => ({
    goal: 'returns integer 0..100',
    in_scope: [],
    out_of_scope: [],
    acceptance_criteria: [
      {
        id: 'ac-1',
        statement: 'returns integer 0..100',
        verdict: 'unverified' as const,
        evidence: [],
        evidence_required: ['test'],
      },
    ],
    unknowns: [],
    follow_up_candidates: [],
    question_policy: 'ask_only_if_user_only_can_answer' as const,
    risk: { non_local: false, irreversible: false, unaudited: false },
    user_confirmation: { confirmed: false, statement: '' },
    ...over,
  });

  test('readiness gate passes but user has NOT confirmed → not_confirmed, no artifact written', async () => {
    await driveToReady();
    const result = await finalizeInterview(repo, {
      workItemId: wiId,
      payload: readyPayload({ user_confirmation: { confirmed: false, statement: '' } }),
    });
    expect(result.status).toBe('not_confirmed');
    expect(await new IntentStore(repo).exists(wiId)).toBe(false);
    expect(await new AutopilotStore(repo).exists(wiId)).toBe(false);
  });

  // wi_260710y87 ac-1/ac-3: risk declared through the interview (payload.risk) is the
  // heavy path's own risk-capture channel. It must land in the work item's declared_risk
  // so the loop's producePlanGate (which reads workItem.declared_risk, autopilot-loop.ts)
  // computes highRisk=true and keeps the plan approval gate pending — instead of
  // auto-waiving a high-risk plan to not_required. Only the TRUE flags are persisted.
  test('high-risk finalize persists payload.risk true-flags into work item declared_risk', async () => {
    await driveToReady();
    const result = await finalizeInterview(repo, {
      workItemId: wiId,
      payload: readyPayload({
        risk: { non_local: false, irreversible: true, unaudited: false },
        user_confirmation: { confirmed: true, statement: '되돌리기 어려운 변경, 승인 필요' },
      }),
    });
    expect(result.status).toBe('finalized');
    const workItem = await new WorkItemStore(repo).get(wiId);
    expect(workItem.declared_risk).toEqual({ irreversible: true });
    // ac-3 proxy: highRiskAssumption over the persisted declared_risk (the exact input
    // producePlanGate feeds highRiskAssumption at autopilot-loop.ts) is true.
    expect(
      highRiskAssumption({
        non_local: workItem.declared_risk?.non_local ?? false,
        irreversible: workItem.declared_risk?.irreversible ?? false,
        unaudited: workItem.declared_risk?.unaudited ?? false,
      }),
    ).toBe(true);
  });

  // wi_260710y87 ac-2: an all-false risk records nothing (same idiom as `work start
  // --risk ""`), so a low-risk WI is not falsely tripped into the high-risk gate.
  test('all-false finalize leaves declared_risk unset', async () => {
    await driveToReady();
    const result = await finalizeInterview(repo, {
      workItemId: wiId,
      payload: readyPayload({
        risk: { non_local: false, irreversible: false, unaudited: false },
        user_confirmation: { confirmed: true, statement: '저위험, 그대로 진행' },
      }),
    });
    expect(result.status).toBe('finalized');
    const workItem = await new WorkItemStore(repo).get(wiId);
    expect(workItem.declared_risk).toBeUndefined();
  });

  // n3 dry termination sets exit.reason='diminishing_returns' but MUST NOT bypass
  // the finalize gate (finalize reads readiness ∧ user confirmation, never exit.reason).
  test('dry exit.reason + critical unresolved → not_ready, no artifact written', async () => {
    await startInterview(repo, { workItemId: wiId });
    // single turn: critical dim partial (gate blocked) + marginal_gain<0.05 → dry.
    const turned = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-crit', critical: true, state: 'partial', ambiguity: 0.5, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q?',
          why_matters: 'm',
          info_gain_estimate: 'low',
          marginal_gain: 0.02,
        },
      },
    });
    expect(turned.exit.reason).toBe('diminishing_returns');
    const result = await finalizeInterview(repo, {
      workItemId: wiId,
      payload: readyPayload({ user_confirmation: { confirmed: true, statement: '맞아요' } }),
    });
    // gate still blocked (critical unresolved) → dry reason did not bypass it.
    expect(result.status).toBe('not_ready');
    expect(await new IntentStore(repo).exists(wiId)).toBe(false);
    expect(await new AutopilotStore(repo).exists(wiId)).toBe(false);
  });

  // recordTurn makes 'diminishing_returns' exclusive with a passing gate (it requires
  // !gate.pass), so to pin "finalize ignores exit.reason even when the gate passes" we
  // construct the adversarial state directly: ready gate + stale dry reason persisted.
  test('dry exit.reason but gate passes + confirmed=false → not_confirmed, no artifact written', async () => {
    await driveToReady();
    const ready = await new InterviewStore(repo).get(wiId);
    await new InterviewStore(repo).write({
      ...ready,
      exit: { ...ready.exit, reason: 'diminishing_returns' },
    });
    const result = await finalizeInterview(repo, {
      workItemId: wiId,
      payload: readyPayload({ user_confirmation: { confirmed: false, statement: '' } }),
    });
    expect(result.status).toBe('not_confirmed');
    expect(await new IntentStore(repo).exists(wiId)).toBe(false);
    expect(await new AutopilotStore(repo).exists(wiId)).toBe(false);
  });

  test('readiness ∧ user confirmation both met → finalized, confirmation persisted on state', async () => {
    await driveToReady();
    const result = await finalizeInterview(repo, {
      workItemId: wiId,
      payload: readyPayload({
        user_confirmation: { confirmed: true, statement: '네, 이 의도가 제가 원한 것입니다' },
      }),
    });
    expect(result.status).toBe('finalized');
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.user_confirmation?.confirmed).toBe(true);
    expect(state.user_confirmation?.statement).toBe('네, 이 의도가 제가 원한 것입니다');
    expect(state.user_confirmation?.confirmed_at).toBeDefined();
  });
});

// wi_260709mqt: intent-layer dissent opponent + honest neutrality axis.
describe('projectInterviewDimensions — intent dissent opponent + honest neutrality (ac-2)', () => {
  async function driveCriticalResolved(): Promise<void> {
    await startInterview(repo, { workItemId: wiId });
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: {
          id: 'd-crit',
          critical: true,
          state: 'resolved',
          ambiguity: 0,
          notes: 'the critical scope',
        },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'scope?',
          why_matters: 'load-bearing',
          info_gain_estimate: 'high',
        },
        answer: { text: 'only local files', kind: 'user' },
        readiness_score: 0.85,
      },
    });
  }

  test('host_absent on a CRITICAL dim → honest deferral close (NOT resolved-with-fake-opponent_ran)', async () => {
    await driveCriticalResolved();
    // no opponent config → host_absent degrade.
    await projectInterviewDimensions(repo, wiId);
    const node = (await new CoverageStore(repo).getMap(wiId)).nodes.find(
      (n) => n.id === 'cov-dim-d-crit',
    );
    // honest degrade: a critical dim with no opponent is deferral-closed, never a fake
    // resolved close that claims an opponent ran.
    expect(node?.state).toBe('out_of_scope');
    // the dissent record-back is persisted (host_absent, self-describing).
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.dimensions.find((d) => d.id === 'd-crit')?.dissent?.status).toBe('host_absent');
  });

  test('engaged opponent on a CRITICAL dim → resolved close + dissent persisted (high impact)', async () => {
    await driveCriticalResolved();
    const cfg = opponentConfig({ delegate: async () => 'the intent is stated too broadly' });
    await projectInterviewDimensions(repo, wiId, cfg);
    const node = (await new CoverageStore(repo).getMap(wiId)).nodes.find(
      (n) => n.id === 'cov-dim-d-crit',
    );
    // real opponent judgment → resolved close (neutrality clamped to accept so the shared
    // coverage axis never sees 'blocked').
    expect(node?.state).toBe('resolved');
    const state = await new InterviewStore(repo).get(wiId);
    const dissent = state.dimensions.find((d) => d.id === 'd-crit')?.dissent;
    expect(dissent?.status).toBe('engaged');
    expect(dissent?.impact).toBe('high');
    expect(dissent?.text).toContain('too broadly');
  });

  test('non-critical resolved dim still closes as resolved (socratic-provenance neutrality)', async () => {
    await startInterview(repo, { workItemId: wiId });
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-min', critical: false, state: 'resolved', ambiguity: 0, notes: 'x' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'minor?',
          why_matters: 'cosmetic',
          info_gain_estimate: 'low',
        },
        answer: { text: 'default', kind: 'user' },
      },
    });
    await projectInterviewDimensions(repo, wiId);
    const node = (await new CoverageStore(repo).getMap(wiId)).nodes.find(
      (n) => n.id === 'cov-dim-d-min',
    );
    expect(node?.state).toBe('resolved');
  });
});

describe('finalizeInterview — critical high-impact dissent gate (ac-3)', () => {
  async function driveReadyWithDissent(dissent: unknown): Promise<void> {
    await startInterview(repo, { workItemId: wiId });
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-shape', critical: true, state: 'resolved', ambiguity: 0.05, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'shape?',
          why_matters: 'response',
          info_gain_estimate: 'high',
        },
        answer: { text: 'integer', kind: 'user' },
        readiness_score: 0.85,
      },
    });
    const store = new InterviewStore(repo);
    const state = await store.get(wiId);
    await store.write({
      ...state,
      dimensions: state.dimensions.map((d) =>
        d.id === 'd-shape' ? { ...d, dissent: dissent as never } : d,
      ),
    });
  }
  const payload: FinalizePayload = {
    goal: 'g',
    in_scope: [],
    out_of_scope: [],
    acceptance_criteria: [
      {
        id: 'ac-1',
        statement: 'returns integer 0..100',
        verdict: 'unverified' as const,
        evidence: [],
        evidence_required: ['test'],
      },
    ],
    unknowns: [],
    follow_up_candidates: [],
    question_policy: 'ask_only_if_user_only_can_answer' as const,
    risk: { non_local: false, irreversible: false, unaudited: false },
    user_confirmation: { confirmed: true, statement: '맞아요' },
  };

  test('engaged high-impact unacknowledged dissent → blocked_by_dissent, no artifact', async () => {
    await driveReadyWithDissent({
      status: 'engaged',
      verdict: 'revise',
      impact: 'high',
      text: 'the intent is too broad',
      acknowledged: false,
    });
    const result = await finalizeInterview(repo, { workItemId: wiId, payload });
    expect(result.status).toBe('blocked_by_dissent');
    if (result.status === 'blocked_by_dissent') {
      expect(result.blocking[0]?.dimension).toBe('d-shape');
      expect(result.blocking[0]?.text).toContain('too broad');
    }
    expect(await new IntentStore(repo).exists(wiId)).toBe(false);
    expect(await new AutopilotStore(repo).exists(wiId)).toBe(false);
  });

  test('acknowledged high-impact dissent → finalizes (user re-confirmed)', async () => {
    await driveReadyWithDissent({
      status: 'engaged',
      verdict: 'revise',
      impact: 'high',
      text: 'the intent is too broad',
      acknowledged: true,
    });
    const result = await finalizeInterview(repo, { workItemId: wiId, payload });
    expect(result.status).toBe('finalized');
  });

  test('host_absent (no dissent / opponent never ran) → NOT blocked, finalizes (ADR-0018 D2)', async () => {
    await driveReadyWithDissent({ status: 'host_absent', acknowledged: false });
    const result = await finalizeInterview(repo, { workItemId: wiId, payload });
    expect(result.status).toBe('finalized');
  });

  test('a dimension with NO dissent at all does not block', async () => {
    await startInterview(repo, { workItemId: wiId });
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-shape', critical: true, state: 'resolved', ambiguity: 0.05, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'shape?',
          why_matters: 'response',
          info_gain_estimate: 'high',
        },
        answer: { text: 'integer', kind: 'user' },
        readiness_score: 0.85,
      },
    });
    const result = await finalizeInterview(repo, { workItemId: wiId, payload });
    expect(result.status).toBe('finalized');
  });

  test('acknowledgeIntentDissent flips the gate from blocked to finalized', async () => {
    await driveReadyWithDissent({
      status: 'engaged',
      verdict: 'revise',
      impact: 'high',
      text: 'too broad',
      acknowledged: false,
    });
    const blocked = await finalizeInterview(repo, { workItemId: wiId, payload });
    expect(blocked.status).toBe('blocked_by_dissent');
    await acknowledgeIntentDissent(repo, wiId, 'd-shape');
    const after = await finalizeInterview(repo, { workItemId: wiId, payload });
    expect(after.status).toBe('finalized');
  });
});

describe('ditto autopilot bootstrap CLI surface', () => {
  test('reads written intent.json and produces an autopilot.json equivalent to the finalize path', async () => {
    // Use the same code path (bootstrapAutopilot) the CLI uses by importing it.
    const { bootstrapAutopilot } = await import('~/core/autopilot-bootstrap');
    await new IntentStore(repo).write({
      schema_version: '0.1.0',
      work_item_id: wiId,
      source_request: 'r',
      goal: 'returns 200',
      in_scope: [],
      out_of_scope: [],
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 'returns 200',
          verdict: 'unverified',
          evidence: [],
          evidence_required: ['test'],
        },
      ],
      unknowns: [],
      follow_up_candidates: [],
      question_policy: 'ask_only_if_user_only_can_answer',
    });
    const workItem = await new WorkItemStore(repo).get(wiId);
    const intent = await new IntentStore(repo).get(wiId);
    const result = await bootstrapAutopilot(repo, {
      workItem,
      intent,
      risk: { non_local: false, irreversible: false, unaudited: false },
    });
    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.graph.work_item_id).toBe(wiId);
      expect(result.graph.root_goal).toBe('returns 200');
    }
  });
});

describe('recordTurn — question context fields (ac-1/ac-4/ac-5, wi_260622ph8)', () => {
  beforeEach(async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
  });

  test('persists user_explanation, background, grounding, self_answer_attempts, and answer self-report', async () => {
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd1', critical: false, state: 'partial', ambiguity: 0.5, notes: '' },
        question: {
          text: 'Which password hash?',
          why_matters: 'Determines the storage format.',
          info_gain_estimate: 'high',
          user_explanation: '비밀번호를 어떻게 안전하게 저장할지 정하는 질문이에요.',
          recommended_answer: '추천 답변 예시입니다.',
          background: '저장 후 바꾸기 어려워 처음에 정해야 합니다.',
          grounding: 'src/auth/store.ts:42',
          self_answer_attempts: [{ source: 'code', result: '코드에 정책이 없어 확인 불가' }],
        },
        answer: { text: 'bcrypt', kind: 'user', self_report: 'confident' },
      },
    });
    const q = state.questions[0];
    expect(q?.user_explanation).toBe('비밀번호를 어떻게 안전하게 저장할지 정하는 질문이에요.');
    expect(q?.background).toBe('저장 후 바꾸기 어려워 처음에 정해야 합니다.');
    expect(q?.grounding).toBe('src/auth/store.ts:42');
    expect(q?.self_answer_attempts.length).toBe(1);
    expect(q?.self_answer_attempts[0]?.source).toBe('code');
    expect(q?.answer_self_report).toBe('confident');
  });
});

// wi_260709d00 (#14): novelty-exhaustion termination axis, wired IN PARALLEL (OR) with the
// marginal_gain dry floor. The novelty dry-counter is reconstructed deterministically from
// interview-state.questions[].novelty (no stored cumulative counter) — reusing coverage's
// recordDryRound/DEFAULT_DRY_K. A round with an UNRESOLVED critical dimension keeps the gate
// blocked, so exit.reason can flip; the default (non-terminal) exit.reason is 'readiness_met'.
describe('recordTurn — novelty-exhaustion termination (wi_260709d00 #14)', () => {
  // Push K novelty:false rounds, each keeping a critical dimension unresolved (gate blocked).
  async function pushRounds(
    novelties: Array<boolean | undefined>,
    marginalGain?: number,
  ): Promise<void> {
    await startInterview(repo, { workItemId: wiId, questionCap: 20 });
    for (let i = 0; i < novelties.length; i++) {
      await recordTurn(repo, {
        workItemId: wiId,
        payload: {
          dimension: { id: 'd-crit', critical: true, state: 'partial', ambiguity: 0.5, notes: '' },
          question: {
            user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
            recommended_answer: '추천 답변 예시입니다.',
            text: `q${i}?`,
            why_matters: 'x',
            info_gain_estimate: 'low',
            ...(novelties[i] !== undefined ? { novelty: novelties[i] } : {}),
            ...(marginalGain !== undefined ? { marginal_gain: marginalGain } : {}),
          },
        },
      });
    }
  }

  test('novelty is persisted on the appended question', async () => {
    await pushRounds([false]);
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.questions[0]?.novelty).toBe(false);
  });

  test('K consecutive novelty:false + gate blocked → diminishing_returns (marginal_gain absent)', async () => {
    // No marginal_gain at all → the ONLY dry signal is novelty exhaustion.
    await pushRounds([false, false]);
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.readiness.gate).toBe('blocked');
    expect(state.exit.reason).toBe('diminishing_returns');
  });

  test('a single novelty:false round is NOT yet dry (K=2)', async () => {
    await pushRounds([false]);
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.exit.reason).toBe('readiness_met'); // default, not terminated
  });

  test('novelty:true keeps it open — marginal_gain alone (absent) does not close', async () => {
    await pushRounds([true, true, true]);
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.exit.reason).toBe('readiness_met');
  });

  test('a novelty:true resets the dry counter (false,true,false → counter 1 < K)', async () => {
    await pushRounds([false, true, false]);
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.exit.reason).toBe('readiness_met');
  });

  test('absent novelty (legacy rounds) never triggers novelty termination (fail-open)', async () => {
    await pushRounds([undefined, undefined, undefined]);
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.exit.reason).toBe('readiness_met');
  });

  test('marginal_gain axis still closes independently even when novelty is fresh (OR contract)', async () => {
    // novelty:true (angle NOT dry) but marginal_gain below floor → value-dry still closes.
    await pushRounds([true], 0.02);
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.exit.reason).toBe('diminishing_returns');
  });
});

// ac-3 (impl-di-recommended-answer): recommended_answer is ADDITIVE-OPTIONAL on the persisted
// interviewQuestion schema — a legacy question object WITHOUT the field still parses, and a
// WITH-field object retains it. Legacy interview-state.json lines must not break.
describe('interviewQuestion schema — recommended_answer additive-optional (ac-3)', () => {
  const legacy = {
    id: 'q001',
    asked_at: '2026-07-13T00:00:00.000Z',
    dimension: 'd1',
    question: 'q?',
    why_matters: 'x',
    info_gain_estimate: 'high' as const,
  };

  test('a legacy interviewQuestion WITHOUT recommended_answer still parses', () => {
    const q = interviewQuestion.parse(legacy);
    expect(q.recommended_answer).toBeUndefined();
    expect(q.id).toBe('q001');
  });

  test('recommended_answer is retained when present', () => {
    const q = interviewQuestion.parse({ ...legacy, recommended_answer: 'bcrypt를 추천합니다.' });
    expect(q.recommended_answer).toBe('bcrypt를 추천합니다.');
  });
});

// ac-1/ac-3 (impl-di-recommended-answer): the recordTurn write path threads recommended_answer
// into the check-question gate AND the persisted question. A turn missing recommended_answer is
// rejected before persist (message names the field); a turn carrying it persists the field.
describe('recordTurn — recommended_answer gate + persistence (ac-1/ac-3)', () => {
  beforeEach(async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
  });

  test('missing recommended_answer → throws, message names recommended_answer, nothing persisted', async () => {
    await expect(
      recordTurn(repo, {
        workItemId: wiId,
        payload: {
          dimension: { id: 'd1', critical: false, state: 'partial', ambiguity: 0.5, notes: '' },
          question: {
            text: '점수는 어떻게 계산하나요?',
            why_matters: '응답 형태를 정합니다.',
            info_gain_estimate: 'high',
            user_explanation: '응답을 어떻게 계산할지 정하는 질문이에요.',
          },
        },
      }),
    ).rejects.toThrow(/recommended_answer/);
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.questions.length).toBe(0);
  });

  test('recommended_answer present → persisted on the appended question', async () => {
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd1', critical: false, state: 'partial', ambiguity: 0.5, notes: '' },
        question: {
          text: '점수는 정수인가요?',
          why_matters: '응답 형식을 정합니다.',
          info_gain_estimate: 'high',
          user_explanation: '응답을 정수로 줄지 정하는 질문이에요.',
          recommended_answer: '정수 0-100을 추천합니다.',
        },
      },
    });
    expect(state.questions[0]?.recommended_answer).toBe('정수 0-100을 추천합니다.');
  });
});

// ac-2 WIRING: the display-time seam on the WRITE path. recordTurn normalizes the user-facing
// question fields (text / user_explanation / recommended_answer) via normalizePresentedText
// BEFORE validating AND persisting — so the presentation gate and the persisted record operate
// on the SAME cleaned text (no "validate one form, persist another" gap flagged in review). A
// question carrying broken/typographic chars (U+FFFD, em-dash, curly quote) is persisted with
// plain chars.
describe('recordTurn — normalizes user-facing question fields before persist (ac-2 wiring)', () => {
  beforeEach(async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
  });

  test('em-dash / U+FFFD / curly-quote in text·user_explanation·recommended_answer → persisted NORMALIZED', async () => {
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd1', critical: false, state: 'partial', ambiguity: 0.5, notes: '' },
        question: {
          text: '점수는 정수인가요 — 소수인가요?', // em-dash U+2014
          why_matters: '응답 형식을 정합니다.',
          info_gain_estimate: 'high',
          user_explanation: '응답을 정수로 줄지 정하는 질문이에요�', // trailing U+FFFD
          recommended_answer: '정수 0-100을 “추천”합니다.', // curly double quotes
        },
      },
    });
    const q = state.questions[0];
    // em-dash → plain hyphen
    expect(q?.question).toBe('점수는 정수인가요 - 소수인가요?');
    expect(q?.question).not.toContain('—');
    // U+FFFD stripped
    expect(q?.user_explanation).toBe('응답을 정수로 줄지 정하는 질문이에요');
    expect(q?.user_explanation).not.toContain('�');
    // curly quotes → straight
    expect(q?.recommended_answer).toBe('정수 0-100을 "추천"합니다.');
  });
});

// ac-1 (impl-ac1-recordturn): the recordTurn WRITE path rejects a bad question surface
// BEFORE persist, wiring the EXISTING pure validators (validateQuestionContext +
// findUnexplainedIdentifiers, question-context.ts) into the write path. A "bad" turn is
// one whose USER-REACHING face (question.text + question.user_explanation) is missing its
// plain-language gloss OR leaks an un-glossed internal identifier. SCOPE LIMIT (pinned by
// the false-negative guard below): ONLY the question surface is checked — answer.text and
// dimension.notes legitimately carry internal vocabulary (wi_/ac-) and must pass. The
// reject Error must NAME what tripped it (missing field / leaked identifier), never a bare
// "rejected", so the caller can fix the exact surface.
describe('recordTurn — question-surface reject before persist (ac-1)', () => {
  beforeEach(async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
  });

  // clause 1: user_explanation is the user-reaching gloss; a turn without it is a bad
  // turn and must be rejected before persist, with the message naming the missing field.
  test('missing/blank user_explanation → throws, message names user_explanation, nothing persisted', async () => {
    await expect(
      recordTurn(repo, {
        workItemId: wiId,
        payload: {
          dimension: { id: 'd1', critical: false, state: 'partial', ambiguity: 0.5, notes: '' },
          question: {
            text: '점수는 어떻게 계산하나요?',
            why_matters: '응답 형태를 정합니다.',
            info_gain_estimate: 'high',
          },
        },
      }),
    ).rejects.toThrow(/user_explanation/);
    // rejected BEFORE the store.write — no question was appended.
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.questions.length).toBe(0);
  });

  // clause 2: an internal identifier leaked on the user-reaching face (question.text)
  // without a gloss must be rejected, and the message must NAME the leaked identifier.
  test('question.text leaks an unglossed identifier → throws, message names the identifier', async () => {
    await expect(
      recordTurn(repo, {
        workItemId: wiId,
        payload: {
          dimension: { id: 'd1', critical: false, state: 'partial', ambiguity: 0.5, notes: '' },
          question: {
            text: 'ac-1을 먼저 진행할까요?',
            why_matters: '순서를 정합니다.',
            info_gain_estimate: 'high',
            user_explanation: '어떤 항목을 먼저 다룰지 정하는 질문이에요.',
            recommended_answer: '추천 답변 예시입니다.',
          },
        },
      }),
    ).rejects.toThrow(/ac-1/);
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.questions.length).toBe(0);
  });

  // clause 3: a fully-contextualized turn (clean text + present user_explanation) persists.
  test('fully-contextualized normal turn → persists (no throw)', async () => {
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd1', critical: false, state: 'partial', ambiguity: 0.5, notes: '' },
        question: {
          text: '점수는 정수인가요?',
          why_matters: '응답 형식을 정합니다.',
          info_gain_estimate: 'high',
          user_explanation: '응답을 정수로 줄지 소수로 줄지 정하는 질문이에요.',
          recommended_answer: '추천 답변 예시입니다.',
        },
      },
    });
    expect(state.questions.length).toBe(1);
  });

  // FALSE-NEGATIVE GUARD (scope limit): identifiers in dimension.notes / answer.text —
  // which legitimately carry wi_/ac- vocabulary — must NOT trip the reject; only the
  // question surface is checked. If this over-rejected, the scope limit would be violated.
  test('identifiers in dimension.notes / answer.text but clean question surface → ACCEPTED', async () => {
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: {
          id: 'd1',
          critical: false,
          state: 'resolved',
          ambiguity: 0.2,
          notes: 'wi_260713nlg 관련 차원',
        },
        question: {
          text: '이 항목을 먼저 다룰까요?',
          why_matters: '작업 순서를 정합니다.',
          info_gain_estimate: 'high',
          user_explanation: '무엇을 먼저 처리할지 정하는 질문이에요.',
          recommended_answer: '추천 답변 예시입니다.',
        },
        answer: { text: 'ac-1 먼저 진행해 주세요', kind: 'user' },
      },
    });
    expect(state.questions.length).toBe(1);
    expect(state.questions[0]?.answer).toContain('ac-1');
  });
});

// wi_260713cx4 (#27): branch-walking wired into the driver. An answer that OPENS a
// dependent decision records branch_edges + a per-turn branch_judgment; value-exhaustion
// (all value branches spent + seam re-survey dry) becomes a governing close signal,
// EMITTED as the existing 'diminishing_returns' (no new enum). cap stays the unconditional
// numeric ceiling; seam under-detection fails OPEN to the cap backstop; malformed edges are
// rejected by the driver's fail-closed referential-integrity guard.
describe('recordTurn — branch-walking (wi_260713cx4 #27)', () => {
  // Push branch rounds: each turn keeps a critical dimension unresolved (gate blocked) and
  // carries an explicit per-turn branch_judgment (opened marks whether a further value branch
  // was opened). No marginal_gain / novelty so the ONLY dry signal is seam value-exhaustion.
  async function pushBranchRounds(
    opened: Array<boolean | undefined>,
    opts: { questionCap?: number; edges?: Array<{ from: string; to: string }> } = {},
  ): Promise<void> {
    await startInterview(repo, { workItemId: wiId, questionCap: opts.questionCap ?? 20 });
    for (let i = 0; i < opened.length; i++) {
      await recordTurn(repo, {
        workItemId: wiId,
        payload: {
          dimension: { id: 'd-crit', critical: true, state: 'partial', ambiguity: 0.5, notes: '' },
          question: {
            user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
            recommended_answer: '추천 답변 예시입니다.',
            text: `q${i}?`,
            why_matters: 'x',
            info_gain_estimate: 'low',
            ...(opts.edges !== undefined ? { branch_edges: opts.edges } : {}),
            ...(opened[i] !== undefined
              ? { branch_judgment: { opened: opened[i] as boolean } }
              : {}),
          },
        },
      });
    }
  }

  test('record-turn persists branch_edges + branch_judgment on the appended question', async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd1', critical: false, state: 'partial', ambiguity: 0.5, notes: '' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q?',
          why_matters: 'x',
          info_gain_estimate: 'high',
          branch_edges: [{ from: 'd1', to: 'd2' }],
          branch_judgment: { opened: true, why: 'the pricing answer opened a currency decision' },
        },
      },
    });
    expect(state.questions[0]?.branch_edges).toEqual([{ from: 'd1', to: 'd2' }]);
    expect(state.questions[0]?.branch_judgment?.opened).toBe(true);
    expect(state.questions[0]?.branch_judgment?.why).toContain('currency');
  });

  test('branch fields survive an existing-dimension re-upsert turn (no silent stale)', async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
    // turn 1 creates d1
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd1', critical: false, state: 'partial', ambiguity: 0.5, notes: 'n' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q0?',
          why_matters: 'x',
          info_gain_estimate: 'low',
        },
      },
    });
    // turn 2 RE-UPSERTS d1 (existing-dimension merge path) AND carries fresh branch fields.
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd1', critical: false, state: 'resolved', ambiguity: 0.1, notes: 'n' },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q1?',
          why_matters: 'x',
          info_gain_estimate: 'low',
          branch_edges: [{ from: 'd1', to: 'd9' }],
          branch_judgment: { opened: false, why: 'no further branch' },
        },
      },
    });
    // The re-upsert applied the dimension update (state resolved) AND persisted the turn's
    // branch fields on the appended question — neither is staled.
    expect(state.dimensions.find((d) => d.id === 'd1')?.state).toBe('resolved');
    expect(state.questions[1]?.branch_edges).toEqual([{ from: 'd1', to: 'd9' }]);
    expect(state.questions[1]?.branch_judgment?.opened).toBe(false);
  });

  test('guardBranchEdges rejects dangling / self / cycle edges (fail-closed integrity)', () => {
    const known = new Set(['d1', 'd2', 'd3']);
    // dangling: to ∉ known → dropped
    expect(guardBranchEdges([{ from: 'd1', to: 'dX' }], known)).toEqual([]);
    expect(guardBranchEdges([{ from: 'dY', to: 'd2' }], known)).toEqual([]);
    // self-edge → dropped
    expect(guardBranchEdges([{ from: 'd1', to: 'd1' }], known)).toEqual([]);
    // cycle: d1→d2 kept, d2→d1 forms a cycle → dropped (only the DAG subset survives)
    expect(
      guardBranchEdges(
        [
          { from: 'd1', to: 'd2' },
          { from: 'd2', to: 'd1' },
        ],
        known,
      ),
    ).toEqual([{ from: 'd1', to: 'd2' }]);
    // valid DAG passes through
    expect(
      guardBranchEdges(
        [
          { from: 'd1', to: 'd2' },
          { from: 'd2', to: 'd3' },
        ],
        known,
      ),
    ).toEqual([
      { from: 'd1', to: 'd2' },
      { from: 'd2', to: 'd3' },
    ]);
  });

  test('orderPendingBranchWork keeps a value-bearing critical branch (never starved)', async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 8 });
    // d-crit (critical, branch TARGET of d-src) stays open; d-breadth is fresh breadth.
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: {
          id: 'd-src',
          critical: false,
          state: 'partial',
          ambiguity: 0.5,
          notes: 'source',
        },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q0?',
          why_matters: 'x',
          info_gain_estimate: 'low',
          branch_edges: [{ from: 'd-src', to: 'd-crit' }],
          branch_judgment: { opened: true },
        },
      },
    });
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: {
          id: 'd-crit',
          critical: true,
          state: 'partial',
          ambiguity: 0.5,
          notes: 'critical branch',
        },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q1?',
          why_matters: 'x',
          info_gain_estimate: 'low',
        },
      },
    });
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: {
          id: 'd-breadth',
          critical: false,
          state: 'partial',
          ambiguity: 0.5,
          notes: 'breadth',
        },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q2?',
          why_matters: 'x',
          info_gain_estimate: 'low',
        },
      },
    });
    const state = await new InterviewStore(repo).get(wiId);
    const order = orderPendingBranchWork(state);
    // order-not-drop: every open dimension survives ordering (breadth never starves the branch).
    expect(order.ordered.map((o) => o.id).sort()).toEqual(['d-breadth', 'd-crit', 'd-src']);
    // the open critical branch target is reported as gating closure.
    expect(order.criticalBranchesOpen).toEqual(['d-crit']);
  });

  test('value-exhaustion (K seam rounds, gate blocked) → diminishing_returns (not a new reason)', async () => {
    await pushBranchRounds([false, false]); // 2 consecutive seam (opened=false) rounds, K=2
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.readiness.gate).toBe('blocked');
    expect(state.exit.reason).toBe('diminishing_returns');
  });

  test('a single seam round is NOT yet value-exhausted (K=2)', async () => {
    await pushBranchRounds([false]);
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.exit.reason).toBe('readiness_met');
  });

  test('seam under-detection (no branch_judgment) fails OPEN — no early close', async () => {
    await pushBranchRounds([undefined, undefined, undefined]);
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.exit.reason).toBe('readiness_met');
  });

  test('an opened=true round resets the seam-dry counter (false,true,false → not exhausted)', async () => {
    await pushBranchRounds([false, true, false]);
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.exit.reason).toBe('readiness_met');
  });

  test('a still-pending value branch (unresolved edge target) blocks value-exhaustion', async () => {
    await startInterview(repo, { workItemId: wiId, questionCap: 20 });
    // turn 1 creates the branch TARGET dimension d-open-target (a REAL, unresolved decision) and
    // opens an edge to it; it stays open through the seam rounds → a pending value branch remains.
    await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: {
          id: 'd-open-target',
          critical: false,
          state: 'partial',
          ambiguity: 0.5,
          notes: 'dependent decision still open',
        },
        question: {
          user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
          recommended_answer: '추천 답변 예시입니다.',
          text: 'q-open?',
          why_matters: 'x',
          info_gain_estimate: 'low',
          branch_edges: [{ from: 'd-crit', to: 'd-open-target' }],
          branch_judgment: { opened: true },
        },
      },
    });
    // two seam rounds on d-crit — but d-open-target (edge target) never resolves.
    for (let i = 0; i < 2; i++) {
      await recordTurn(repo, {
        workItemId: wiId,
        payload: {
          dimension: { id: 'd-crit', critical: true, state: 'partial', ambiguity: 0.5, notes: '' },
          question: {
            user_explanation: '이 질문이 무엇을 결정하는지 사용자 언어로 설명합니다.',
            recommended_answer: '추천 답변 예시입니다.',
            text: `q${i}?`,
            why_matters: 'x',
            info_gain_estimate: 'low',
            branch_judgment: { opened: false },
          },
        },
      });
    }
    const state = await new InterviewStore(repo).get(wiId);
    // pending value branch (unresolved edge target) → isBranchSeam false → no value-exhaustion.
    expect(state.exit.reason).toBe('readiness_met');
  });

  test('cap wins over value-exhaustion (both true on the same turn)', async () => {
    // questionCap=2: two seam rounds hit BOTH the cap AND value-exhaustion; cap must win.
    await pushBranchRounds([false, false], { questionCap: 2 });
    const state = await new InterviewStore(repo).get(wiId);
    expect(state.exit.questions_asked).toBe(2);
    expect(state.exit.reason).toBe('cap_reached');
  });
});
