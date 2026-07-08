import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordRound, recordRoundPayload } from '~/core/question-round';
import { WorkItemStore } from '~/core/work-item-store';
import { type QuestionRound, questionRound, questionRoundPayload } from '~/schemas/question-round';

const VALID_SCORE = { consensus: 2, quality: 0.8, necessity: 0.7, answer_value: 0.9 };

describe('question-round schema (증분 3 — 점수 영속 sink)', () => {
  test('a selected (non-dry) round payload parses with the 4-dim score', () => {
    const r = questionRoundPayload.parse({
      round: 1,
      section: 'background',
      generator_count: 3,
      dry: false,
      selected: [
        {
          text: 'Path X goes through JWT; enforce here too?',
          property: 'blind-spot',
          why_matters: 'auth scope changes the contract',
          scores: VALID_SCORE,
          rationale: 'raised by 2 generators',
        },
      ],
      all_scored: [
        { text: 'q1', property: 'blind-spot', scores: VALID_SCORE },
        { text: 'q2', property: 'expansion', scores: { ...VALID_SCORE, consensus: 1 } },
      ],
    });
    expect(r.round).toBe(1);
    expect(r.selected[0]?.scores.answer_value).toBe(0.9);
    expect(r.generator_count).toBe(3);
  });

  test('generator_count defaults to 2 (--generators default 2, range 1..6; wi_260619yfw)', () => {
    const r = questionRoundPayload.parse({ round: 1, dry: true, all_scored: [] });
    expect(r.generator_count).toBe(2);
    expect(r.selected).toEqual([]);
  });

  test('score out of [0,1] range is rejected', () => {
    const bad = questionRoundPayload.safeParse({
      round: 1,
      dry: false,
      selected: [
        { text: 'q', property: 'orientation', scores: { ...VALID_SCORE, answer_value: 1.5 } },
      ],
    });
    expect(bad.success).toBe(false);
  });

  test('consensus must be a non-negative integer', () => {
    const bad = questionRoundPayload.safeParse({
      round: 1,
      dry: false,
      selected: [{ text: 'q', property: 'blind-spot', scores: { ...VALID_SCORE, consensus: -1 } }],
    });
    expect(bad.success).toBe(false);
  });

  test('invariant: dry=true requires empty selected (gate signalled no question above threshold)', () => {
    const bad = questionRoundPayload.safeParse({
      round: 1,
      dry: true,
      selected: [{ text: 'q', property: 'blind-spot', scores: VALID_SCORE }],
    });
    expect(bad.success).toBe(false);
  });

  test('invariant: dry=false requires at least one selected', () => {
    const bad = questionRoundPayload.safeParse({ round: 1, dry: false, selected: [] });
    expect(bad.success).toBe(false);
  });

  test('the persisted line schema additionally requires ts + work_item_id', () => {
    const line: QuestionRound = questionRound.parse({
      ts: '2026-06-19T05:00:00.000Z',
      work_item_id: 'wi_260619khn',
      round: 1,
      dry: true,
      selected: [],
      all_scored: [],
      generator_count: 3,
    });
    expect(line.work_item_id).toBe('wi_260619khn');
    expect(
      questionRound.safeParse({ round: 1, dry: true, selected: [], all_scored: [] }).success,
    ).toBe(false);
  });
});

describe('recordRound (증분 3 — 점수 영속 sink)', () => {
  let repo: string;
  let wiId: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-qr-'));
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

  test('appends a round to question-rounds.jsonl, stamping ts + work_item_id', async () => {
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
    const rounds = await new WorkItemStore(repo).readQuestionRounds(wiId);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.selected[0]?.scores.answer_value).toBe(0.9);
    expect(rounds[0]?.generator_count).toBe(2); // --generators default 2 (wi_260619yfw)
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
    const rounds = await new WorkItemStore(repo).readQuestionRounds(wiId);
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
