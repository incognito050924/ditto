import { z } from 'zod';
import { evidenceRef, relativePath, uncertaintyItem, verdict } from './common';

// Which owner role authored this return. The four autopilot owners that emit a
// human+machine return (wi_260627jhh); `retrospective` is the legit-empty
// exemption for the substantive-detail refine below (it presents two SEPARATE
// metrics, not a verbatim body).
export const ownerKind = z
  .enum(['implementer', 'researcher', 'retrospective', 'refactorer'])
  .describe('Which owner role authored this owner-return envelope');

// Common owner-return envelope (wi_260627jhh, ac-1). Formalizes the HUMAN return
// (summary / conclusion / uncertainty) while keeping the STRUCTURED machine slots
// distinct (evidence / verdict / changed-file pointers ride alongside). Embedded
// as an ADDITIVE OPTIONAL field on recordResultPayload so a legacy payload with no
// envelope round-trips byte-identical.
//
//   - `summary` is the ONLY slot the main/driver loads into context (ac-2).
//   - `verbatim_detail` is the lossless detail — NO size-cap (oversized passes);
//     it is preserved+expandable and is DISTINCT from the summary (ac-2/ac-4).
//   - `artifact_location` is a resolvable repo-relative pointer to a preserved
//     non-empty artifact (an alternative to inline verbatim_detail for bulk).
export const ownerReturnEnvelope = z
  .object({
    summary: z
      .string()
      .min(1)
      .describe(
        'The ONLY slot the main/driver loads into context (ac-2); a pointer-index, not the body',
      ),
    // Also the carrier for the decisive classes WITHOUT a dedicated slot —
    // intent / decisions / irreversible-risks (uncertainty is the lone structured
    // decisive slot). Owner docs instruct placing those here so summary-only loses
    // none of the four classes (ac-3); the lossless channel stays the design, no
    // per-class field is added.
    verbatim_detail: z
      .string()
      .optional()
      .describe(
        'Lossless detail kept near-verbatim; NO size-cap (oversized passes). Distinct from summary; ' +
          'preserved and expandable (ac-2/ac-4).',
      ),
    artifact_location: relativePath
      .optional()
      .describe('Repo-relative pointer to a preserved non-empty artifact holding the detail'),
    conclusion: z.string().min(1).describe('The bottom-line judgment of the return'),
    evidence: z.array(evidenceRef).default([]).describe('Evidence pointers (reuses evidenceRef)'),
    uncertainty: z
      .array(uncertaintyItem)
      .default([])
      .describe('Declared open uncertainties (reuses the shared uncertaintyItem)'),
    verdict,
    owner_kind: ownerKind,
  })
  .superRefine((env, ctx) => {
    // Substantive detail must be REACHABLE: either inline `verbatim_detail`
    // (non-empty) or an `artifact_location` pointer. A bare summary with neither
    // is rejected — it would lose the lossless detail the envelope exists to keep.
    // EXEMPTION: a `retrospective` return is legitimately empty here (it presents
    // two SEPARATE metrics, not a verbatim body), so it is not held to this rule.
    if (env.owner_kind === 'retrospective') return;
    const hasInline = (env.verbatim_detail?.trim().length ?? 0) > 0;
    const hasPointer = env.artifact_location !== undefined;
    if (!hasInline && !hasPointer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verbatim_detail'],
        message:
          'substantive detail must be reachable: provide a non-empty verbatim_detail or an ' +
          'artifact_location (a bare summary with neither is rejected)',
      });
    }
  })
  .describe(
    'Owner-return envelope: formalizes the human return while keeping the structured machine slots distinct',
  );

export type OwnerReturnEnvelope = z.infer<typeof ownerReturnEnvelope>;
export type OwnerKind = z.infer<typeof ownerKind>;
