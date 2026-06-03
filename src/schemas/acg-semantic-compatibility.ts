import { z } from 'zod';
import { acgChangeEnvelope } from './acg-common';

/**
 * ACG SemanticCompatibility (20-contracts §4) — separates type compatibility
 * from meaning compatibility. The split verdict (type_safe vs semantic_safe) is
 * the point: "type-safe" and "semantically safe" are different judgments.
 */

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
    }),
  })
  .describe('ACG SemanticCompatibility — type vs meaning split verdict');

export type AcgSemanticCompatibility = z.infer<typeof acgSemanticCompatibility>;
