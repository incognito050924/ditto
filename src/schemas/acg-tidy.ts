import { z } from 'zod';

/**
 * ACG Tidy artifacts. The ⓪ entry classifier persists its
 * SKIP/ENTER verdict so the decision is auditable (G3 — 축소는 드러낸다).
 */
export const tidyClassification = z
  .object({
    decision: z.enum(['ENTER', 'SKIP']),
    reason: z.string().min(1),
    codeFiles: z.number().int().nonnegative(),
    codeLines: z.number().int().nonnegative(),
  })
  .describe('⓪ tidy entry classifier verdict (diff-stat only; slop is not an input)');

export type TidyClassification = z.infer<typeof tidyClassification>;
