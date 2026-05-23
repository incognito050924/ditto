import { z } from 'zod';
import {
  evidenceRef,
  isoDateTime,
  relativePath,
  runId,
  schemaVersion,
  verdict,
  workItemId,
} from './common';

export const acceptanceVerdict = z
  .object({
    criterion_id: z.string().min(1),
    verdict: verdict,
    evidence: z.array(evidenceRef).default([]),
    notes: z.string().optional(),
  })
  .describe('Per-criterion result included in the completion claim');

export const completionContract = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    declared_by: z.string().min(1).describe('Profile or agent that produced this completion claim'),
    declared_at: isoDateTime,
    summary: z
      .string()
      .min(1)
      .max(2000)
      .describe('What changed, in user-facing terms; no implementation jargon'),
    changed_files: z.array(relativePath).default([]),
    acceptance: z
      .array(acceptanceVerdict)
      .min(1)
      .describe('Every acceptance criterion must appear here; absence is a contract violation'),
    verifications: z
      .array(
        z.object({
          command: z.string().min(1),
          exit_code: z.number().int(),
          run_id: runId.optional(),
          evidence: evidenceRef.optional(),
        }),
      )
      .default([])
      .describe('Commands actually executed; not aspirational'),
    unverified: z
      .array(
        z.object({
          item: z.string().min(1).describe('What was not verified'),
          reason: z.string().min(1).describe('Why verification did not happen'),
          out_of_scope: z
            .boolean()
            .default(false)
            .describe(
              'True when the item is intentionally outside acceptance scope; only such items are allowed when final_verdict=pass',
            ),
        }),
      )
      .default([])
      .describe('Anything the implementer could not verify; explicit not-knowing is required'),
    remaining_risks: z.array(z.string()).default([]),
    next_handoff_path: relativePath
      .optional()
      .describe('Where the next session/agent should pick up; required if status is not done'),
    final_verdict: verdict.describe(
      'Aggregate verdict; "pass" requires every acceptance verdict to be pass',
    ),
  })
  .superRefine((value, ctx) => {
    if (value.final_verdict === 'pass') {
      const failing = value.acceptance.filter((a) => a.verdict !== 'pass');
      if (failing.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `final_verdict=pass but ${failing.length} acceptance criterion not pass`,
          path: ['final_verdict'],
        });
      }
      const inScopeUnverified = value.unverified.filter((u) => !u.out_of_scope);
      if (inScopeUnverified.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `final_verdict=pass but ${inScopeUnverified.length} in-scope unverified item(s) remain; mark out_of_scope=true if intentionally outside acceptance`,
          path: ['unverified'],
        });
      }
    }
    if (value.final_verdict !== 'pass' && !value.next_handoff_path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'non-pass final_verdict requires next_handoff_path',
        path: ['next_handoff_path'],
      });
    }
  })
  .describe('Contract that gates work item completion; absence of fields is a failure');

export type CompletionContract = z.infer<typeof completionContract>;
export type AcceptanceVerdict = z.infer<typeof acceptanceVerdict>;
