import { z } from 'zod';
import {
  declarerRole,
  evidenceRef,
  isoDateTime,
  relativePath,
  runId,
  schemaVersion,
  uncertaintyItem,
  verdict,
  workItemId,
} from './common';
import { evidenceRecord } from './evidence-record';

// Declared class of why an item is unverified OR why a remaining risk is surfaced
// in-flow instead of auto-fixed. The first four are the original
// unverified-resolvability classes; the last four are the ac-3 surfacing-reason
// categories (T1, wi_2606266az). They ride the SAME enum — not a parallel field
// (R11) — so the gate reads one label space across both `unverified[]` and
// `remaining_risk_records[]`. Read by the gate, never computed here.
export const resolvability = z
  .enum([
    'agent_resolvable',
    'blocked_external',
    'user_decision',
    'accepted_tradeoff',
    'decision_or_adr_conflict',
    'multiple_comparable_solutions',
    'out_of_scope',
    'genuinely_dangerous',
  ])
  .describe('Declared class of why an item is unverified or a risk is surfaced; read by the gate');

export const acceptanceVerdict = z
  .object({
    criterion_id: z.string().min(1),
    verdict: verdict,
    // `evidence`는 기존 bare evidenceRef 배열(legacy, 폐기하지 않음).
    // `evidence_records`는 freshness/portability로 감싼 sidecar(설계서 §6.7 line 698).
    // optional + default [] 이므로 기존 completion 은 마이그레이션 없이 그대로 유효하다.
    evidence: z.array(evidenceRef).default([]),
    evidence_records: z
      .array(evidenceRecord)
      .default([])
      .describe('Optional freshness/portability-wrapped evidence; coexists with `evidence`'),
    notes: z.string().optional(),
  })
  .describe('Per-criterion result included in the completion claim');

export const completionContract = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    declared_by: declarerRole.describe(
      'Agent role that judged this completion (who declared), not the execution profile; impersonation is rejected at the schema',
    ),
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
        // Reuses the shared `uncertaintyItem` base (`{item, reason}`, common.ts)
        // and EXTENDS it with the resolvability/grounding/out_of_scope fields the
        // gate routes on. Extending keeps `{item, reason}` byte-identical to the
        // prior inline shape (same min(1) validation) — legacy completions
        // round-trip unchanged — while the envelope reuses the same base.
        uncertaintyItem.extend({
          out_of_scope: z
            .boolean()
            .default(false)
            .describe(
              'True when the item is intentionally outside acceptance scope; only such items are allowed when final_verdict=pass',
            ),
          // Additive + optional, so a legacy completion.json without these
          // round-trips byte-identically (no default on resolvability). The
          // Stop hook/gate reads this declared label and the grounding ref to
          // decide; the schema only stores them and never computes
          // resolvability itself (deterministic-floor, gates.ts:10-14 idiom).
          resolvability: resolvability
            .optional()
            .describe(
              'Declared class of why this is unverified; read by the gate, not computed here',
            ),
          grounding: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Free-text oracle/ref (ADR id, dependency, decision pointer, file:line); a non-resolvable class attaches it and the gate later checks its presence',
            ),
        }),
      )
      .default([])
      .describe('Anything the implementer could not verify; explicit not-knowing is required'),
    remaining_risks: z.array(z.string()).default([]),
    // ac-3 (T1, wi_2606266az): structured residual-risk records carrying the
    // resolvability label + grounding the gate routes on — agent_resolvable risks
    // auto-fix; the four surfacing-reason classes surface in-flow. Mirrors the
    // `unverified[]` item shape and the legacy/rich split of `evidence` vs
    // `evidence_records`: the bare `remaining_risks` string[] above is untouched
    // (legacy completions round-trip byte-identical and the existing string[]
    // consumers are unchanged), and this OPTIONAL sibling carries the richer shape.
    // `.optional()` (no default) so a legacy completion.json omitting it parses
    // byte-identical, the same idiom work-item `follow_ups` uses.
    remaining_risk_records: z
      .array(
        z.object({
          risk: z.string().min(1).describe('The residual risk, in user-facing terms'),
          resolvability: resolvability
            .optional()
            .describe(
              'Declared class; agent_resolvable routes to auto-fix, the four surfacing classes surface in-flow',
            ),
          grounding: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Oracle/ref (ADR id, decision pointer, file:line); a non-auto-fix class attaches it and the gate later checks its presence',
            ),
        }),
      )
      .optional()
      .describe(
        'Optional resolvability/grounding-labeled residual risks; coexists with `remaining_risks`',
      ),
    // ac-1 (T1, wi_2606266az): a non-pass completion's HONEST partial/blocked
    // declaration — the explicit status + reason + grounding the ac-1 gate reads to
    // tell an honest partial/blocked termination (allowed) from an undeclared
    // unverified leak (blocked). Additive + OPTIONAL: a legacy non-pass
    // completion.json omits it and parses unchanged. The required-when-non-pass
    // ENFORCEMENT lives in the gate (gates.ts), NOT in superRefine here — a
    // required-on-non-pass refine would reject legacy on-disk non-pass completions
    // and fail-closed (exit 2) (R10). When the field IS present, reason+grounding
    // are required within the object (an honest declaration is never empty).
    non_pass_status: z
      .object({
        state: z
          .enum(['partial', 'blocked'])
          .describe('honest partial (progress made, some AC non-pass) or blocked (cannot proceed)'),
        reason: z.string().min(1).describe('Why the completion is partial/blocked'),
        grounding: z
          .string()
          .min(1)
          .describe('Oracle/ref for the blocker (ADR id, dependency, decision pointer, file:line)'),
      })
      .optional()
      .describe(
        'Optional honest partial/blocked declaration for a non-pass completion; read by the ac-1 gate, not enforced in superRefine (R10)',
      ),
    // ACG governance slot (WU-6, D5). Optional: absent → current completion flow
    // unchanged (acc-c). When present, records the acg.review-graph.v1 ledger the
    // completion was judged against and any identities still unresolved at high
    // risk (empty = governance gate clear). Enforcement lives in the Stop hook
    // (it reads the ledger directly); this is the recording surface on completion.
    acg_governance: z
      .object({
        review_graph: relativePath.describe('Path to the acg.review-graph.v1 ledger consulted'),
        unresolved_high_risk: z
          .array(z.string())
          .default([])
          .describe('Identities (path|journey_id) still unresolved at high risk; empty = clear'),
      })
      .optional()
      .describe('Optional ACG review-by-exception governance state (D5)'),
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
    // Structural note only: a non-resolvable class (blocked_external |
    // user_decision | accepted_tradeoff) is expected to attach `grounding`,
    // but grounding-presence is NOT enforced here. That blocking judgement
    // lives in the Stop hook later (it reads the label); enforcing it in the
    // schema would reject existing on-disk completion.json (backward-compat).
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
