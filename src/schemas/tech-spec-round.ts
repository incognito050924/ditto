import { z } from 'zod';
import { isoDateTime, workItemId } from './common';

/**
 * tech-spec question-generation round (증분 3 — 점수 영속 sink). One persisted
 * record of the multi-agent question workflow (SKILL.md §"Question generation
 * workflow"): the selection gate's scored candidates for one round, appended to
 * `.ditto/local/work-items/<id>/tech-spec-rounds.jsonl` (root level, mirroring
 * metrics.jsonl — measurement instrumentation, not per-AC evidence; ADR-0005 D1,
 * gitignored tier ③). `ditto doctor intent-quality` reads it as the question-VALUE
 * signal alongside the deep-interview question-COUNT signal. Scores are recorded
 * for later tuning; analysis consumption stays additive (no new instrumentation).
 *
 * Distinct from the OLD `question-gate.ts` (deep-interview §6.2 pre-ask gate) —
 * this is the tech-spec 4-dim selection score.
 */
export const questionProperty = z
  .enum(['blind-spot', 'expansion', 'orientation'])
  .describe('Which good-question property the candidate carries (SKILL.md §good questions)');

export const questionScore = z
  .object({
    consensus: z
      .number()
      .int()
      .nonnegative()
      .describe('How many generators independently raised this question (necessity signal)'),
    quality: z.number().min(0).max(1).describe('Meets the three good-question properties [0..1]'),
    necessity: z.number().min(0).max(1).describe('Still open given the fixed facts [0..1]'),
    answer_value: z
      .number()
      .min(0)
      .max(1)
      .describe('How much the spec changes depending on the answer [0..1]'),
  })
  .describe('The gate 4-dimension score for one candidate question');

export const scoredQuestion = z
  .object({
    text: z.string().min(1),
    property: questionProperty,
    why_matters: z.string().optional(),
    scores: questionScore,
    rationale: z.string().optional().describe('Why selected (present on selected questions)'),
  })
  .describe('One candidate question with its gate score');

/** The CLI payload (what the driver records); ts + work_item_id are stamped on persist. */
export const techSpecRoundPayload = z
  .object({
    round: z.number().int().positive().describe('1-based round index within the interview'),
    section: z.string().optional().describe('Target spec section this round filled'),
    generator_count: z
      .number()
      .int()
      .positive()
      .default(2)
      .describe('N generators fanned out (--generators default 2, range 1..6; wi_260619yfw)'),
    threshold: z.number().optional().describe('Fixed selection threshold used this round (§9 #4)'),
    dry: z
      .boolean()
      .describe('Gate found no candidate above the threshold → round/interview ends (§9 #4)'),
    selected: z.array(scoredQuestion).default([]).describe('Questions selected to ask the user'),
    all_scored: z
      .array(scoredQuestion)
      .default([])
      .describe('Every candidate with its score (durable score trail for later tuning)'),
  })
  .superRefine((val, ctx) => {
    // dry ⟺ nothing selected: the gate signals dry only when no candidate clears
    // the threshold, so a dry round with selected questions (or a non-dry round
    // with none) is a malformed record.
    if (val.dry && val.selected.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selected'],
        message: 'dry=true 라운드는 selected가 비어 있어야 한다 (임계 이상 질문 부재가 dry의 정의)',
      });
    }
    if (!val.dry && val.selected.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dry'],
        message: 'selected가 비어 있으면 dry=true여야 한다 (선정된 질문이 없는 라운드는 dry)',
      });
    }
  });

export type TechSpecRoundPayload = z.infer<typeof techSpecRoundPayload>;

/** The persisted JSONL line: payload + provenance stamp. */
export const techSpecRound = z
  .object({
    ts: isoDateTime,
    work_item_id: workItemId,
    round: z.number().int().positive(),
    section: z.string().optional(),
    generator_count: z.number().int().positive().default(2),
    threshold: z.number().optional(),
    dry: z.boolean(),
    selected: z.array(scoredQuestion).default([]),
    all_scored: z.array(scoredQuestion).default([]),
  })
  .describe('One line of .ditto/local/work-items/<id>/tech-spec-rounds.jsonl');

export type TechSpecRound = z.infer<typeof techSpecRound>;
