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

export const dittoConfig = z
  .object({
    tech_spec: z
      .object({
        question: dittoConfigQuestion.optional(),
      })
      .optional(),
  })
  .describe('Per-developer ditto config — .ditto/local/config.json (tier ③, gitignored)');

export type DittoConfigQuestion = z.infer<typeof dittoConfigQuestion>;
export type DittoConfig = z.infer<typeof dittoConfig>;
