import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interviewReadinessGate } from '~/core/gates';
import {
  deriveDimensionMappings,
  deriveIntentFragments,
  recordIntentSemanticCritique,
  selectIntentSemanticTargets,
} from '~/core/interview-driver';
import { InterviewStore } from '~/core/interview-store';
import type { InterviewDimension, InterviewState } from '~/schemas/interview-state';

// wi_260709hzg (#15): prism A1 achieve-vs-characterize semantic critic ported to the
// deep-interview intent layer — deterministic fragment↔dimension mapping + advisory,
// NON-blocking critic on covered pairs only.

function dim(over: Partial<InterviewDimension> & { id: string }): InterviewDimension {
  return {
    critical: false,
    state: 'resolved',
    ambiguity: 0,
    resolved_by: [],
    notes: '',
    ...over,
  };
}

describe('AC-1 deriveIntentFragments (deterministic decomposition)', () => {
  test('splits the original intent into clause fragments with stable ids, drops blanks', () => {
    const frags = deriveIntentFragments('Add a password-strength endpoint.\nReturn a 0-100 score.');
    expect(frags.length).toBe(2);
    expect(frags[0]?.id).toBe('frag[0]');
    expect(frags[1]?.id).toBe('frag[1]');
    expect(frags[0]?.text).toContain('password-strength');
  });

  test('empty / whitespace intent → no fragments', () => {
    expect(deriveIntentFragments('   ')).toEqual([]);
  });
});

describe('AC-1 deriveDimensionMappings (whole-token match · wi_260708jnp lesson)', () => {
  const fragments = deriveIntentFragments('Return a password strength score');

  test('maps a fragment to a resolved dimension that shares a WHOLE token', () => {
    const dims = [dim({ id: 'd-score', notes: 'what score range does the endpoint return' })];
    const maps = deriveDimensionMappings(fragments, dims);
    expect(maps).toContainEqual({ fragment_id: 'frag[0]', dimension_id: 'd-score' });
  });

  test('does NOT map on a word-INTERNAL substring (no false coverage)', () => {
    // fragment token 'score' must NOT match a dimension whose only near-hit is 'scoreboard'
    // as a different whole token — and 'core' (substring of 'score') must not bleed either.
    const dims = [dim({ id: 'd-core', notes: 'the core provider wiring' })];
    const maps = deriveDimensionMappings(fragments, dims);
    expect(maps).toEqual([]);
  });

  test('ignores non-resolved dimensions (only resolved dimensions are covered)', () => {
    const dims = [dim({ id: 'd-open', state: 'partial', notes: 'password strength score' })];
    expect(deriveDimensionMappings(fragments, dims)).toEqual([]);
  });
});

describe('AC-2 selectIntentSemanticTargets (FANOUT_CAP)', () => {
  const fragments = deriveIntentFragments('password strength score endpoint');

  test('caps the emitted targets and reports the skipped remainder', () => {
    const dims = [
      dim({ id: 'd1', notes: 'password' }),
      dim({ id: 'd2', notes: 'strength' }),
      dim({ id: 'd3', notes: 'score' }),
      dim({ id: 'd4', notes: 'endpoint' }),
    ];
    const { targets, skipped_by_cap } = selectIntentSemanticTargets(fragments, dims, 2);
    expect(targets.length).toBe(2);
    expect(skipped_by_cap).toBe(2);
  });
});

describe('AC-2 recordIntentSemanticCritique (advisory fold · ADR-0018 degrade)', () => {
  const NOW = new Date('2026-07-09T00:00:00.000Z');

  async function seed(dims: InterviewDimension[]): Promise<string> {
    const repo = mkdtempSync(join(tmpdir(), 'intent-semantic-'));
    const store = new InterviewStore(repo);
    const state: InterviewState = {
      schema_version: '0.1.0',
      work_item_id: 'wi_test0001',
      status: 'active',
      started_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      dimensions: dims,
      readiness: { score: 1, threshold: 0.8, critical_unresolved: [], gate: 'ready' },
      questions: [],
      assumptions: [],
      premortem: [],
      exit: {
        reason: 'readiness_met',
        closure_mode: 'mutual_agreement',
        question_cap: 10,
        questions_asked: 0,
      },
    };
    await store.write(state);
    return repo;
  }

  test('non-empty text → engaged semantic_critique on the dimension', async () => {
    const repo = await seed([dim({ id: 'd-score', notes: 'score' })]);
    const out = await recordIntentSemanticCritique(
      repo,
      'wi_test0001',
      [{ dimension_id: 'd-score', text: 'characterizes the score but never fixes the range' }],
      NOW,
    );
    expect(out.status).toBe('recorded');
    if (out.status !== 'recorded') return;
    expect(out.engaged).toEqual(['d-score']);
    const d = out.state.dimensions.find((x) => x.id === 'd-score');
    expect(d?.semantic_status).toBe('engaged');
    expect(d?.semantic_critique).toContain('characterizes');
  });

  test('whitespace text → host_absent degrade (never a fake engaged)', async () => {
    const repo = await seed([dim({ id: 'd-score', notes: 'score' })]);
    const out = await recordIntentSemanticCritique(
      repo,
      'wi_test0001',
      [{ dimension_id: 'd-score', text: '   ' }],
      NOW,
    );
    expect(out.status).toBe('recorded');
    if (out.status !== 'recorded') return;
    expect(out.degraded).toEqual(['d-score']);
    expect(out.state.dimensions[0]?.semantic_status).toBe('host_absent');
  });

  test('foreign dimension_id → status foreign, writes NOTHING', async () => {
    const repo = await seed([dim({ id: 'd-score', notes: 'score' })]);
    const out = await recordIntentSemanticCritique(
      repo,
      'wi_test0001',
      [{ dimension_id: 'd-ghost', text: 'x' }],
      NOW,
    );
    expect(out.status).toBe('foreign');
    if (out.status !== 'foreign') return;
    expect(out.foreign).toContain('d-ghost');
    const state = await new InterviewStore(repo).get('wi_test0001');
    expect(state.dimensions[0]?.semantic_status).toBeUndefined();
  });
});

describe('AC-3 semantic critic is NON-blocking (readiness gate ignores semantic_*)', () => {
  test('a critical resolved dimension with an engaged (characterize) critique still passes readiness', () => {
    const state: InterviewState = {
      schema_version: '0.1.0',
      work_item_id: 'wi_test0002',
      status: 'active',
      started_at: '2026-07-09T00:00:00.000Z',
      updated_at: '2026-07-09T00:00:00.000Z',
      dimensions: [
        dim({
          id: 'd-crit',
          critical: true,
          state: 'resolved',
          notes: 'score',
          semantic_status: 'engaged',
          semantic_critique: 'only characterizes, does not achieve',
        }),
      ],
      readiness: { score: 1, threshold: 0.8, critical_unresolved: [], gate: 'ready' },
      questions: [],
      assumptions: [],
      premortem: [],
      exit: {
        reason: 'readiness_met',
        closure_mode: 'mutual_agreement',
        question_cap: 10,
        questions_asked: 0,
      },
    };
    // The characterize critique must NOT flip the gate — advisory only.
    expect(interviewReadinessGate(state).pass).toBe(true);
  });
});
