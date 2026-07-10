import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutopilotStore } from '~/core/autopilot-store';
import { CoverageStore } from '~/core/coverage-store';
import { IntentStore } from '~/core/intent-store';
import {
  type FinalizePayload,
  acknowledgeIntentDissent,
  checkReadiness,
  finalizeInterview,
  projectInterviewDimensions,
  recordTurn,
  startInterview,
} from '~/core/interview-driver';
import { InterviewStore } from '~/core/interview-store';
import type { OpponentSeamConfig } from '~/core/prism/opponent';
import { WorkItemStore } from '~/core/work-item-store';

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
        question: { text: 'q1?', why_matters: 'because', info_gain_estimate: 'medium' },
      },
    });
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd1', critical: false, state: 'resolved', ambiguity: 0.1, notes: '' },
        question: { text: 'q2?', why_matters: 'follow-up', info_gain_estimate: 'low' },
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
        question: { text: 'q1?', why_matters: 'unknown', info_gain_estimate: 'medium' },
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
        question: { text: 'critical?', why_matters: 'load-bearing', info_gain_estimate: 'high' },
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
        question: { text: 'critical?', why_matters: 'load-bearing', info_gain_estimate: 'high' },
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
        question: { text: 'minor?', why_matters: 'cosmetic', info_gain_estimate: 'low' },
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
        question: { text: 'q1?', why_matters: 'because', info_gain_estimate: 'medium' },
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
          question: { text: `q${i}?`, why_matters: 'x', info_gain_estimate: 'medium' },
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
          question: { text: `q${i}?`, why_matters: 'x', info_gain_estimate: 'low' },
        },
      });
    }
    const state = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd2', critical: true, state: 'partial', ambiguity: 0.5, notes: '' },
        question: {
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
        question: { text: 'shape?', why_matters: 'response', info_gain_estimate: 'high' },
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
        question: { text: 'critical?', why_matters: 'load-bearing', info_gain_estimate: 'high' },
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
        question: { text: 'critical?', why_matters: 'load-bearing', info_gain_estimate: 'high' },
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
        question: { text: 'q?', why_matters: 'm', info_gain_estimate: 'high' },
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
        question: { text: 'shape?', why_matters: 'response', info_gain_estimate: 'high' },
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
        question: { text: 'shape?', why_matters: 'response', info_gain_estimate: 'high' },
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
        question: { text: 'shape?', why_matters: 'response', info_gain_estimate: 'high' },
        answer: { text: 'integer', kind: 'user' },
        readiness_score: 0.85,
      },
    });
  }
  const readyPayload = (over: Record<string, unknown>) => ({
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

  // n3 dry termination sets exit.reason='diminishing_returns' but MUST NOT bypass
  // the finalize gate (finalize reads readiness ∧ user confirmation, never exit.reason).
  test('dry exit.reason + critical unresolved → not_ready, no artifact written', async () => {
    await startInterview(repo, { workItemId: wiId });
    // single turn: critical dim partial (gate blocked) + marginal_gain<0.05 → dry.
    const turned = await recordTurn(repo, {
      workItemId: wiId,
      payload: {
        dimension: { id: 'd-crit', critical: true, state: 'partial', ambiguity: 0.5, notes: '' },
        question: { text: 'q?', why_matters: 'm', info_gain_estimate: 'low', marginal_gain: 0.02 },
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
        question: { text: 'scope?', why_matters: 'load-bearing', info_gain_estimate: 'high' },
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
        question: { text: 'minor?', why_matters: 'cosmetic', info_gain_estimate: 'low' },
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
        question: { text: 'shape?', why_matters: 'response', info_gain_estimate: 'high' },
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
        question: { text: 'shape?', why_matters: 'response', info_gain_estimate: 'high' },
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
