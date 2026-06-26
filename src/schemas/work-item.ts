import { z } from 'zod';
import {
  evidenceRef,
  isoDateTime,
  profileName,
  relativePath,
  runId,
  schemaVersion,
  verdict,
  workItemId,
  workItemStatus,
} from './common';

const gitSha40 = z
  .string()
  .regex(/^[a-f0-9]{40}$/, 'git sha must be 40 lowercase hex characters')
  .describe('Full 40-char git commit sha');

// ADR-0024 §3.1: re-evaluability class of an AC oracle. NEW axis (re-evaluability
// strength), distinct from intent.ts evidenceRequiredKind (= *kind of evidence*:
// test|diff|browser|doc|log). dynamic_test = hard·dynamic (executed), static_scan =
// hard·static (re-scanned), soft_judgment = soft (review / user-decision).
export const verificationMethod = z
  .enum(['dynamic_test', 'static_scan', 'soft_judgment'])
  .describe(
    'Re-evaluability class of the oracle (ADR-0024 §3.1: hard·dynamic / hard·static / soft·judgment). Distinct from evidenceRequiredKind (intent.ts), which is the kind of evidence, not its re-evaluability.',
  );

// ADR-0024 §3.0/§3 raise≠resolution: a code-pointer maps_to (file:line or
// path:symbol) names a frozen current-code position that drifts as code changes.
// Valid for a `backward` oracle (a current-code finding); rejected for a `forward`
// oracle (evaluated on the post-change final state — must stay re-evaluable).
const codePointerMapsTo = /^[^\s]+\.[A-Za-z0-9]+:[^\s]+$/;

export const acOracle = z
  .object({
    // §3.1 — re-evaluability class; references evidenceRequiredKind to keep the
    // relationship explicit (this is a different axis, not a duplicate).
    verification_method: verificationMethod,
    // §3 — anchor target. Same vocabulary as dialectic.ts opponentObjection.maps_to
    // ("AC, file:line, intent, or doc"); do not reinvent.
    maps_to: z
      .string()
      .min(1)
      .describe(
        'AC, file:line, intent, or doc the oracle anchors to (same vocabulary as dialectic maps_to)',
      ),
    // §3.0 — forward = evaluated on the post-change final state; backward =
    // current-code finding.
    direction: z
      .enum(['forward', 'backward'])
      .describe(
        'forward = post-change final state; backward = current-code finding (ADR-0024 §3.0)',
      ),
  })
  .superRefine((value, ctx) => {
    if (value.direction === 'forward' && codePointerMapsTo.test(value.maps_to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'forward oracle must be re-evaluable: a code-pointer maps_to (file:line / symbol) drifts on change — use direction=backward for a current-code finding (ADR-0024 §3.0)',
        path: ['maps_to'],
      });
    }
  })
  .describe('Per-AC oracle: re-evaluable verification method + anchor target (ADR-0024 §3)');

export const acceptanceCriterion = z
  .object({
    id: z.string().min(1).describe('Stable id within the work item (e.g., ac-1)'),
    statement: z.string().min(1).describe('Single observable behavior in user-facing terms'),
    verdict: verdict.default('unverified'),
    evidence: z.array(evidenceRef).default([]),
    // Additive + OPTIONAL (ADR-0024 §3): legacy ACs omit it and parse unchanged;
    // no schema_version bump (same idiom as autopilot_exempt / sourceDigest).
    oracle: acOracle.optional(),
    // Provenance of graded criteria replaced via `work set-criteria --supersede`
    // (prior statement + reason). Lock-with-provenance so a verified criterion is
    // not silently overwritten (goalpost-moving, charter §4-6). Additive + OPTIONAL:
    // legacy ACs omit it and parse unchanged; no schema_version bump.
    superseded: z
      .array(
        z.object({
          statement: z.string().min(1).describe('The prior (graded) statement that was replaced'),
          reason: z.string().min(1).describe('Why the prior criterion was superseded'),
        }),
      )
      .optional(),
  })
  .describe('One acceptance criterion with its verification verdict');

export const riskNote = z
  .object({
    description: z.string().min(1),
    severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).default('low'),
    mitigation: z.string().optional(),
  })
  .describe('Outstanding risk that did not block completion but remains relevant');

export const reEntry = z
  .object({
    command: z.string().optional().describe('Concrete next command to resume work'),
    fresh_evidence_needed: z
      .array(z.string())
      .default([])
      .describe('What new evidence must be gathered before the next attempt'),
    owner: z.string().optional().describe('Profile or human handle expected to resume'),
  })
  .describe('Instructions for resuming a partial/unverified/blocked work item');

export const workItem = z
  .object({
    schema_version: schemaVersion,
    id: workItemId,
    title: z.string().min(1).max(200),
    source_request: z
      .string()
      .min(1)
      .describe('Verbatim or close-paraphrase of the original user request'),
    goal: z
      .string()
      .min(1)
      .describe('Observable outcome stated in project terms; not a list of steps'),
    acceptance_criteria: z.array(acceptanceCriterion).min(1),
    status: workItemStatus.default('draft'),
    owner_profile: profileName.default('workspace-write'),
    parent_id: workItemId.optional().describe('Parent work item if this is a child task'),
    child_ids: z.array(workItemId).default([]),
    changed_files: z.array(relativePath).default([]),
    // (B) plan→autopilot transition escape hatch (wi_260615xby). When true, the
    // Stop gate lets this work item close on a completion.json ALONE without ever
    // bootstrapping autopilot — the explicit "this work did not need the
    // finalize→bootstrap→drive path" marker. Optional + additive: a legacy
    // work-item.json omits it and parses + behaves exactly as before.
    autopilot_exempt: z
      .boolean()
      .optional()
      .describe('Allow closing on completion.json alone without going through autopilot'),
    risks: z.array(riskNote).default([]),
    re_entry: reEntry.optional(),
    runs: z.array(runId).default([]),
    handoff_path: relativePath.optional(),
    language_overrides: relativePath
      .optional()
      .describe('Path to language.md if this work item modifies the glossary'),
    started_at_sha: gitSha40
      .optional()
      .describe(
        'Git HEAD sha at the time this work item transitioned draft → in_progress; used as default base for handoff diff collection',
      ),
    created_at: isoDateTime,
    updated_at: isoDateTime,
    closed_at: isoDateTime.optional(),
  })
  .superRefine((value, ctx) => {
    const needsReEntry = (['partial', 'unverified', 'blocked'] as const).includes(
      value.status as 'partial' | 'unverified' | 'blocked',
    );
    if (!needsReEntry) return;
    if (!value.re_entry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `status=${value.status} requires re_entry with command or fresh_evidence_needed`,
        path: ['re_entry'],
      });
      return;
    }
    const hasCommand =
      typeof value.re_entry.command === 'string' && value.re_entry.command.length > 0;
    const hasEvidence = value.re_entry.fresh_evidence_needed.length > 0;
    if (!hasCommand && !hasEvidence) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `status=${value.status} requires re_entry.command or non-empty re_entry.fresh_evidence_needed`,
        path: ['re_entry'],
      });
    }
  })
  .describe('Authoritative state for a single DITTO work item');

export type WorkItem = z.infer<typeof workItem>;
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterion>;
export type AcOracle = z.infer<typeof acOracle>;
export type ReEntry = z.infer<typeof reEntry>;
