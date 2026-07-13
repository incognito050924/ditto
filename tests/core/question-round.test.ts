import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismStore } from '~/core/prism/store';
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

// ac-1 (impl-ac1-prism): the record-turn presentation contract must ALSO gate the
// prism-equivalent WRITE path (PrismStore.appendValueRound). Over each user-reaching
// selected question (its text + user_explanation) the sink rejects, BEFORE persisting,
// on (a) a missing user_explanation or (b) an un-glossed internal identifier leaked on
// the user face — and the reject message serializes the violation (field/reason +
// leaked identifier), not a bare "rejected". why_matters / the raw all_scored trail are
// out of this user-reaching surface. Rounds are constructed DIRECTLY against the sink:
// the current prism callers (prism.ts) build text-free scalar rounds, so this is a
// defensive backstop for future text-carrying callers, not reachable through them today.
describe('presentation contract on the prism-equivalent write path (ac-1)', () => {
  let repo: string;
  let wiId: string;
  let store: PrismStore;
  const ctxScore = { consensus: 2, quality: 0.8, necessity: 0.7, answer_value: 0.9 };

  const round = (selected: unknown[]): QuestionRound =>
    questionRound.parse({
      ts: '2026-07-13T00:00:00.000Z',
      work_item_id: wiId,
      round: 1,
      dry: false,
      selected,
      all_scored: [],
      generator_count: 2,
    });

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-qr-prism-'));
    const wi = await new WorkItemStore(repo).create({
      title: 'demo',
      source_request: 'demo',
      goal: 'demo',
      acceptance_criteria: [{ id: 'ac-1', statement: 'TBD', verdict: 'unverified', evidence: [] }],
    });
    wiId = wi.id;
    store = new PrismStore(repo);
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test('appendValueRound rejects a selected question missing user_explanation, before persist', async () => {
    const bad = round([
      { text: 'Should we enforce auth here too?', property: 'blind-spot', scores: ctxScore },
    ]);
    await expect(store.appendValueRound(wiId, bad)).rejects.toThrow(/user_explanation/);
    expect(await store.readValueRounds(wiId)).toHaveLength(0);
  });

  test('appendValueRound rejects an un-glossed internal identifier in selected text (message names it)', async () => {
    const bad = round([
      {
        text: 'Does prism_ab12 apply?',
        user_explanation: 'We need to know whether that node belongs to this change.',
        property: 'blind-spot',
        scores: ctxScore,
      },
    ]);
    let err: Error | undefined;
    try {
      await store.appendValueRound(wiId, bad);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message).toContain('prism_ab12');
    expect(await store.readValueRounds(wiId)).toHaveLength(0);
  });

  test('appendValueRound persists a clean, fully-contextualized selected round', async () => {
    const clean = round([
      {
        text: 'Should we require a login before checkout?',
        user_explanation: 'This decides whether guests can buy — it changes the whole flow.',
        why_matters: 'auth scope changes the contract',
        property: 'blind-spot',
        scores: ctxScore,
      },
    ]);
    const persisted = await store.appendValueRound(wiId, clean);
    expect(persisted.selected[0]?.user_explanation).toContain('guests');
    expect(await store.readValueRounds(wiId)).toHaveLength(1);
  });
});
