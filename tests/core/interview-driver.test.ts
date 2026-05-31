import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutopilotStore } from '~/core/autopilot-store';
import { IntentStore } from '~/core/intent-store';
import {
  checkReadiness,
  finalizeInterview,
  recordTurn,
  startInterview,
} from '~/core/interview-driver';
import { InterviewStore } from '~/core/interview-store';
import { WorkItemStore } from '~/core/work-item-store';

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
