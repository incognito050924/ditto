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

export const acceptanceCriterion = z
  .object({
    id: z.string().min(1).describe('Stable id within the work item (e.g., ac-1)'),
    statement: z.string().min(1).describe('Single observable behavior in user-facing terms'),
    verdict: verdict.default('unverified'),
    evidence: z.array(evidenceRef).default([]),
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
export type ReEntry = z.infer<typeof reEntry>;
