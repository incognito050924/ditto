import { z } from 'zod';
import { acgChangeEnvelope } from './acg-common';
import { acgFitnessVerdictReproducibility } from './acg-fitness-verdict';

/**
 * ACG SemanticCompatibility — separates type compatibility
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

/**
 * One signature change pair plus its per-pair meaning verdict. The detector
 * (signature-codeql.ts) finds ALL changed pairs in a diff; the blocking artifact
 * now carries the full set so every breaking/unverified pair reaches the Stop
 * gate, not just the first (G4 multi-change). verdict/resolution are per-pair —
 * one pair can be a declared-intended break while another is still unverified.
 */
export const acgSemanticCompatibilityChange = z.object({
  before: z.string().min(1),
  after: z.string().min(1),
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
      adequacy: z
        .enum(['l1_met', 'l2_passed', 'none'])
        .default('none')
        .describe(
          'Adequacy of the cited characterization (OBJ-11): l1_met = the changed region is executed by the test (L1), l2_passed = the old↔new differential passed (L2). none = mere existence, which is INSUFFICIENT for an agent semantic_safe=yes.',
        ),
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
});

export type AcgSemanticCompatibilityChange = z.infer<typeof acgSemanticCompatibilityChange>;

export const acgSemanticCompatibility = z
  .object({
    ...acgChangeEnvelope('acg.semantic-compatibility.v1'),
    changes: z.array(acgSemanticCompatibilityChange).min(1),
  })
  .superRefine((value, ctx) => {
    value.changes.forEach((change, i) => {
      // An AGENT-produced `yes` carries two machine-evidence obligations; a
      // USER-produced `yes` is a human attestation, exempt from BOTH (mirrors the
      // intended_breaking human override). The split is on produced_by:
      //   1. reproducibility — a pinned judge model, so the LLM verdict is
      //      reproducible (dialectic-1 O5; mirrors acg-fitness-verdict llm_judged).
      //   2. characterization — a passing behavior test that WITNESSES the meaning
      //      holds; the judge says "I think it holds", the test proves it (sv1 O6).
      if (value.produced_by === 'agent' && change.verdict.semantic_safe === 'yes') {
        if (!change.verdict.reproducibility) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "agent-produced semantic_safe='yes' requires verdict.reproducibility (model_version)",
            path: ['changes', i, 'verdict', 'reproducibility'],
          });
        }
        const ref = change.characterization?.test_ref;
        const witnessed =
          change.characterization?.exists === true && typeof ref === 'string' && ref.length > 0;
        if (!witnessed) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "agent-produced semantic_safe='yes' requires characterization.exists=true with a non-empty test_ref (a passing behavior test must witness the preserved meaning)",
            path: ['changes', i, 'characterization', 'test_ref'],
          });
        }
        // 3. adequacy — the cited test must be ADEQUATE, not merely existing
        //    (OBJ-11): it executes the changed region (l1_met) or its old↔new
        //    differential passed (l2_passed). A bare ref (adequacy=none) leaves
        //    the over-fitting/coverage-blind-spot gap §4 warns about.
        const adequacy = change.characterization?.adequacy;
        if (adequacy !== 'l1_met' && adequacy !== 'l2_passed') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "agent-produced semantic_safe='yes' requires characterization.adequacy of 'l1_met' or 'l2_passed' (the cited test must execute the changed region or pass an old↔new differential — ref existence alone is insufficient, OBJ-11)",
            path: ['changes', i, 'characterization', 'adequacy'],
          });
        }
      }
      // The unverified sentinel is a seed placeholder only; yes/no must carry the
      // real domain meaning (dialectic-1 O4).
      if (
        change.verdict.semantic_safe !== 'unverified' &&
        change.old_meaning === SEMANTIC_UNVERIFIED_SENTINEL
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `old_meaning '${SEMANTIC_UNVERIFIED_SENTINEL}' is a seed placeholder; provide the real domain meaning before declaring yes/no`,
          path: ['changes', i, 'old_meaning'],
        });
      }
    });
  })
  .describe('ACG SemanticCompatibility — type vs meaning split verdict (multi-change)');

export type AcgSemanticCompatibility = z.infer<typeof acgSemanticCompatibility>;
