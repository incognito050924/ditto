import { z } from 'zod';

/**
 * Per-developer ditto config (tier ③) — `.ditto/local/config.json`, gitignored.
 *
 * `tech_spec.question` carries per-option defaults for the §6-6
 * question-elicitation tuning (wi_260619jmu). It is RawQuestionConfig-shaped:
 * every field optional, same bounds as the CLI flags. When a CLI flag is absent
 * the config value is used; an explicit CLI flag still wins. Fail-open belongs at
 * the READER (a broken config returns `{}`), so the schema keeps the strict
 * bounds rather than loosening them.
 */
export const dittoConfigQuestion = z
  .object({
    intensity: z.number().int().min(0).max(100).optional(),
    generators: z.number().int().min(1).max(6).optional(),
    performance: z.enum(['glance', 'quick', 'standard', 'deep', 'exhaustive']).optional(),
    generator_effort: z.enum(['low', 'medium', 'high', 'inherit']).optional(),
    gate_mode: z.enum(['confirm', 'draft']).optional(),
    max_questions: z.number().int().nonnegative().optional(),
    max_rounds: z.number().int().nonnegative().optional(),
    threshold: z.number().min(0).max(1).optional(),
    granularity: z.enum(['low', 'medium', 'high']).optional(),
  })
  .describe('Per-user defaults for §6-6 question-elicitation (RawQuestionConfig-shaped)');

/**
 * Per-developer defaults for the deep-interview lifecycle (`deep_interview` block).
 * Each field optional, same bounds as the `ditto deep-interview start` CLI flags
 * (threshold ∈ [0,1], question_cap a positive int, generators a positive int).
 * When a CLI flag is absent the config value is used; an explicit CLI flag wins.
 * Distinct from `tech_spec.question` — deep-interview and tech-spec are separate
 * surfaces with their own option sets, so they do not share a config block.
 */
export const dittoConfigDeepInterview = z
  .object({
    threshold: z.number().min(0).max(1).optional(),
    question_cap: z.number().int().positive().optional(),
    generators: z.number().int().positive().optional(),
  })
  .describe('Per-user defaults for deep-interview start (CLI-flag-shaped)');

export const dittoConfig = z
  .object({
    tech_spec: z
      .object({
        question: dittoConfigQuestion.optional(),
      })
      .optional(),
    deep_interview: dittoConfigDeepInterview.optional(),
  })
  .describe('Per-developer ditto config — .ditto/local/config.json (tier ③, gitignored)');

export type DittoConfigQuestion = z.infer<typeof dittoConfigQuestion>;
export type DittoConfigDeepInterview = z.infer<typeof dittoConfigDeepInterview>;
export type DittoConfig = z.infer<typeof dittoConfig>;
