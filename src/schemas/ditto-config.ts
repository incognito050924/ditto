import { z } from 'zod';

/**
 * Per-developer ditto config (tier ③) — `.ditto/local/config.json`, gitignored.
 *
 * `prism.question` carries per-option defaults for the question-elicitation
 * tuning (wi_260619jmu, renamed from the retired authoring surface's config
 * block in wi_260707oi1). Every field optional, same bounds as the CLI flags. When
 * a CLI flag is absent the config value is used; an explicit CLI flag still wins.
 * Fail-open belongs at the READER (a broken config returns `{}`), so the schema
 * keeps the strict bounds rather than loosening them.
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
  .describe('Per-user defaults for question-elicitation (every field optional, CLI-flag-shaped)');

/**
 * Per-developer defaults for the deep-interview lifecycle (`deep_interview` block).
 * Each field optional, same bounds as the `ditto deep-interview start` CLI flags
 * (threshold ∈ [0,1], question_cap a positive int, generators a positive int).
 * When a CLI flag is absent the config value is used; an explicit CLI flag wins.
 * Distinct from `prism.question` — deep-interview and the intent-authoring surface
 * are separate surfaces with their own option sets, so they do not share a block.
 */
export const dittoConfigDeepInterview = z
  .object({
    threshold: z.number().min(0).max(1).optional(),
    question_cap: z.number().int().positive().optional(),
    generators: z.number().int().positive().optional(),
  })
  .describe('Per-user defaults for deep-interview start (CLI-flag-shaped)');

/**
 * GitHub Project (백로그 SoT) 연결 config (`github` block; wi_260628d79, G9/D8).
 *
 * `ditto github setup` wizard writes this. `status_map` binds ditto's structured
 * termination enum to a Project v2 single-select status option id (D7) — KEYS are
 * limited to `done` | `abandoned` ONLY (the two terminal work-item states ditto
 * mirrors to the board; any other key makes the whole config schema-invalid so the
 * fail-open reader drops it). The map MAY be partial or empty (unmapped → skip +
 * 안내, 우아한 강등). `auto_reflect` defaults to false (OFF) — the writer always
 * sets it explicitly, so it is required here.
 */
export const dittoConfigGithub = z
  .object({
    project: z.object({
      owner: z.string().min(1),
      number: z.number().int().positive(),
      node_id: z.string().min(1).optional(),
    }),
    status_map: z.record(z.enum(['done', 'abandoned']), z.string().min(1)),
    // wi_2606287v9 (#5) ac-5/ac-9: NON-TERMINAL board-status mapping (claim ->
    // "In Progress", blocked -> "Blocked"). Kept in a SEPARATE optional field rather
    // than extending the terminal status_map enum above: a non-terminal key added to
    // that closed enum makes an OLD/stale-bundle reader reject the WHOLE github config
    // (zod), and the fail-open reader then drops the entire github block AND poisons
    // sibling prism/deep_interview defaults. As a separate field with OPEN string
    // keys, an old reader simply STRIPS the unknown key (z.object is non-strict) and a
    // future non-terminal key is just carried — per-key degradation, never a
    // whole-config drop. The writer validates which keys it emits (in_progress,
    // blocked). Additive + OPTIONAL; no schema_version bump.
    claim_status_map: z.record(z.string().min(1), z.string().min(1)).optional(),
    auto_reflect: z.boolean(),
  })
  .describe('GitHub Project 연결 config — D7 status 매핑(키=done|abandoned) + auto-reflect');

export const dittoConfig = z
  .object({
    prism: z
      .object({
        question: dittoConfigQuestion.optional(),
      })
      .optional(),
    deep_interview: dittoConfigDeepInterview.optional(),
    github: dittoConfigGithub.optional(),
  })
  .describe('Per-developer ditto config — .ditto/local/config.json (tier ③, gitignored)');

export type DittoConfigQuestion = z.infer<typeof dittoConfigQuestion>;
export type DittoConfigDeepInterview = z.infer<typeof dittoConfigDeepInterview>;
export type DittoConfigGithub = z.infer<typeof dittoConfigGithub>;
export type DittoConfig = z.infer<typeof dittoConfig>;
