import { describe, expect, test } from 'bun:test';
import { type TechSpecRound, techSpecRound, techSpecRoundPayload } from '~/schemas/tech-spec-round';

const VALID_SCORE = { consensus: 2, quality: 0.8, necessity: 0.7, answer_value: 0.9 };

describe('tech-spec-round schema (증분 3 — 점수 영속 sink)', () => {
  test('a selected (non-dry) round payload parses with the 4-dim score', () => {
    const r = techSpecRoundPayload.parse({
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

  test('generator_count defaults to 3 (§9 #5 N=3 고정)', () => {
    const r = techSpecRoundPayload.parse({ round: 1, dry: true, all_scored: [] });
    expect(r.generator_count).toBe(3);
    expect(r.selected).toEqual([]);
  });

  test('score out of [0,1] range is rejected', () => {
    const bad = techSpecRoundPayload.safeParse({
      round: 1,
      dry: false,
      selected: [
        { text: 'q', property: 'orientation', scores: { ...VALID_SCORE, answer_value: 1.5 } },
      ],
    });
    expect(bad.success).toBe(false);
  });

  test('consensus must be a non-negative integer', () => {
    const bad = techSpecRoundPayload.safeParse({
      round: 1,
      dry: false,
      selected: [{ text: 'q', property: 'blind-spot', scores: { ...VALID_SCORE, consensus: -1 } }],
    });
    expect(bad.success).toBe(false);
  });

  test('invariant: dry=true requires empty selected (gate signalled no question above threshold)', () => {
    const bad = techSpecRoundPayload.safeParse({
      round: 1,
      dry: true,
      selected: [{ text: 'q', property: 'blind-spot', scores: VALID_SCORE }],
    });
    expect(bad.success).toBe(false);
  });

  test('invariant: dry=false requires at least one selected', () => {
    const bad = techSpecRoundPayload.safeParse({ round: 1, dry: false, selected: [] });
    expect(bad.success).toBe(false);
  });

  test('the persisted line schema additionally requires ts + work_item_id', () => {
    const line: TechSpecRound = techSpecRound.parse({
      ts: '2026-06-19T05:00:00.000Z',
      work_item_id: 'wi_260619khn',
      round: 1,
      dry: true,
      selected: [],
      all_scored: [],
      generator_count: 3,
    });
    expect(line.work_item_id).toBe('wi_260619khn');
    // payload schema (no ts/work_item_id) must reject when those leak in is NOT required;
    // but the line schema must reject a missing work_item_id.
    expect(
      techSpecRound.safeParse({ round: 1, dry: true, selected: [], all_scored: [] }).success,
    ).toBe(false);
  });
});
