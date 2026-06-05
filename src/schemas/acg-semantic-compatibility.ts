import { z } from 'zod';
import { acgChangeEnvelope } from './acg-common';
import { acgFitnessVerdictReproducibility } from './acg-fitness-verdict';

/**
 * ACG SemanticCompatibility (20-contracts §4) — separates type compatibility
 * from meaning compatibility. The split verdict (type_safe vs semantic_safe) is
 * the point: "type-safe" and "semantically safe" are different judgments.
 */

/**
 * Placeholder the static `ditto semantic detect` seed writes for `old_meaning`:
 * the diff-level extractor knows the signature pair but NOT the domain meaning,
 * which is an LLM/agent judgment. The sentinel is schema-valid ONLY while the
 * verdict is still `unverified`; the `ditto semantic verdict` resolver must
 * replace it with the real meaning before declaring `yes`/`no` (dialectic-1 O4).
 */
export const SEMANTIC_UNVERIFIED_SENTINEL = '__unverified__';

export const acgSemanticCompatibility = z
  .object({
    ...acgChangeEnvelope('acg.semantic-compatibility.v1'),
    change: z.object({ before: z.string().min(1), after: z.string().min(1) }),
    old_meaning: z.string().min(1).describe('Domain meaning the old signature expressed'),
    business_assumptions: z
      .array(z.string().min(1))
      .default([])
      .describe('Implicit assumptions callers depended on'),
    compatibility: z.enum(['compatible', 'additive', 'breaking']),
    characterization: z
      .object({
        exists: z.boolean(),
        test_ref: z.string().nullable().default(null),
        candidate: z
          .string()
          .nullable()
          .default(null)
          .describe('Generated candidate when no behavior test exists'),
      })
      .optional(),
    verdict: z.object({
      type_safe: z.boolean(),
      semantic_safe: z.enum(['yes', 'no', 'unverified']),
      intended_breaking: z.boolean().optional(),
      reproducibility: acgFitnessVerdictReproducibility
        .optional()
        .describe(
          'Pinned judge model for an LLM meaning judgment; required for an agent-produced semantic_safe=yes (a user yes is a human attestation, exempt)',
        ),
    }),
  })
  .superRefine((value, ctx) => {
    // An AGENT-produced `yes` carries two machine-evidence obligations; a
    // USER-produced `yes` is a human attestation, exempt from BOTH (mirrors the
    // intended_breaking human override). The split is on produced_by:
    //   1. reproducibility — a pinned judge model, so the LLM verdict is
    //      reproducible (dialectic-1 O5; mirrors acg-fitness-verdict llm_judged).
    //   2. characterization — a passing behavior test that WITNESSES the meaning
    //      holds; the judge says "I think it holds", the test proves it (sv1 O6).
    if (value.produced_by === 'agent' && value.verdict.semantic_safe === 'yes') {
      if (!value.verdict.reproducibility) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "agent-produced semantic_safe='yes' requires verdict.reproducibility (model_version)",
          path: ['verdict', 'reproducibility'],
        });
      }
      const ref = value.characterization?.test_ref;
      const witnessed =
        value.characterization?.exists === true && typeof ref === 'string' && ref.length > 0;
      if (!witnessed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "agent-produced semantic_safe='yes' requires characterization.exists=true with a non-empty test_ref (a passing behavior test must witness the preserved meaning)",
          path: ['characterization', 'test_ref'],
        });
      }
    }
    // The unverified sentinel is a seed placeholder only; yes/no must carry the
    // real domain meaning (dialectic-1 O4).
    if (
      value.verdict.semantic_safe !== 'unverified' &&
      value.old_meaning === SEMANTIC_UNVERIFIED_SENTINEL
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `old_meaning '${SEMANTIC_UNVERIFIED_SENTINEL}' is a seed placeholder; provide the real domain meaning before declaring yes/no`,
        path: ['old_meaning'],
      });
    }
  })
  .describe('ACG SemanticCompatibility — type vs meaning split verdict');

export type AcgSemanticCompatibility = z.infer<typeof acgSemanticCompatibility>;
