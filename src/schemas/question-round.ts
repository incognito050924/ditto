import { z } from 'zod';
import { isoDateTime, workItemId } from './common';

/**
 * question-generation round (증분 3 — 점수 영속 sink). One persisted record of
 * the multi-agent question workflow: the selection gate's scored candidates for
 * one round, appended to `.ditto/local/work-items/<id>/question-rounds.jsonl`
 * (root level, mirroring metrics.jsonl — measurement instrumentation, not per-AC
 * evidence; ADR-0005 D1, gitignored tier ③). `ditto doctor intent-quality` reads
 * it as the question-VALUE signal alongside the deep-interview question-COUNT
 * signal. Scores are recorded for later tuning; analysis consumption stays
 * additive (no new instrumentation).
 *
 * Distinct from `question-gate.ts` (deep-interview §6.2 pre-ask gate) — this is
 * the 4-dim selection score of the question-elicitation workflow.
 */
export const questionProperty = z
  .enum(['blind-spot', 'expansion', 'orientation'])
  .describe(
    'Which good-question property the candidate carries (blind-spot / expansion / orientation)',
  );

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
    // Presentation-contract fields (wi_260628wr8 ac-6) — the same user-facing context
    // deep-interview carries (src/core/question-context.ts). A plain-language why-we-ask
    // + what-the-answer-decides (`user_explanation`) and the progressive-disclosure tiers
    // (`background`/`grounding`). Optional so the raw score trail (all_scored) and existing
    // question-rounds.jsonl lines stay valid; the driver's pre-ask gate
    // (`ditto deep-interview check-question`) hard-requires them on SELECTED (user-reaching) questions.
    user_explanation: z.string().optional(),
    background: z.string().optional(),
    grounding: z.string().optional(),
    // Recommended-answer context (impl-di-recommended-answer, ac-3). ADDITIVE-OPTIONAL so the
    // raw score trail (all_scored) and every pre-existing question-rounds.jsonl line stay valid.
    // The deep-interview pre-ask gate (`ditto deep-interview check-question`) hard-requires it on
    // SELECTED (user-reaching) questions, mirroring user_explanation. Benign here for prism (ac-4).
    recommended_answer: z.string().optional(),
    scores: questionScore,
    rationale: z.string().optional().describe('Why selected (present on selected questions)'),
  })
  .describe('One candidate question with its gate score');

export type ScoredQuestion = z.infer<typeof scoredQuestion>;

/** The CLI payload (what the driver records); ts + work_item_id are stamped on persist. */
export const questionRoundPayload = z
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
    // wi_260708yut: did THIS round add admissible novelty? Additive-optional so legacy
    // lines (field absent) stay valid; derived deterministically from the prism
    // detectDivergence verdict (no new probability field). Persisted so an offline
    // replay can later demonstrate value-of-information (B6 data premise).
    novelty: z
      .boolean()
      .optional()
      .describe('Whether this round added admissible novelty (deterministic; wi_260708yut)'),
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

export type QuestionRoundPayload = z.infer<typeof questionRoundPayload>;

/** The persisted JSONL line: payload + provenance stamp. */
export const questionRound = z
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
    // wi_260708yut — additive-optional; see questionRoundPayload.novelty above.
    novelty: z.boolean().optional(),
  })
  .describe('One line of .ditto/local/work-items/<id>/question-rounds.jsonl');

export type QuestionRound = z.infer<typeof questionRound>;
