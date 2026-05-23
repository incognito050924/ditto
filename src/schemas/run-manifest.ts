import { z } from 'zod';
import {
  isoDateTime,
  profileName,
  providerName,
  relativePath,
  runId,
  schemaVersion,
  workItemId,
} from './common';

export const gitState = z
  .object({
    head: z
      .string()
      .regex(/^[a-f0-9]{40}$/, 'git head must be a full 40-char sha')
      .describe('Commit sha at the moment of capture'),
    branch: z.string().optional(),
    dirty: z.boolean().describe('Whether the working tree has uncommitted changes'),
    untracked_count: z.number().int().nonnegative().default(0),
  })
  .describe('Snapshot of git state taken before or after a run');

export const verification = z
  .object({
    command: z.string().min(1).describe('Exact command executed to verify outcome'),
    exit_code: z.number().int(),
    duration_ms: z.number().int().nonnegative().optional(),
    output_path: relativePath
      .optional()
      .describe('Where the verification output is stored as evidence'),
    notes: z.string().optional(),
  })
  .describe('A single verification attempt performed inside or after the run');

export const runManifest = z
  .object({
    schema_version: schemaVersion,
    id: runId,
    work_item_id: workItemId,
    provider: providerName,
    entrypoint: z
      .string()
      .min(1)
      .describe('How the provider was invoked, e.g., "codex exec" or "claude code"'),
    model_reported: z
      .string()
      .nullable()
      .describe('Model name as reported by the provider; null if unknown'),
    profile: profileName,
    cwd: relativePath.describe('Repo-relative working directory of the run'),
    prompt_path: relativePath
      .optional()
      .describe('Path to the prompt/context packet handed to the provider'),
    git_before: gitState,
    git_after: gitState.optional(),
    changed_files: z.array(relativePath).default([]),
    stdout_path: relativePath.optional(),
    stderr_path: relativePath.optional(),
    diff_path: relativePath.optional(),
    exit_code: z.number().int().nullable().describe('null if the provider was killed or crashed'),
    started_at: isoDateTime,
    ended_at: isoDateTime.optional(),
    verifications: z.array(verification).default([]),
    unverified: z
      .array(z.string())
      .default([])
      .describe('Items the run could not verify and why, one entry per item'),
    notes: z.string().optional(),
  })
  .describe('Authoritative record of a single provider invocation');

export type RunManifest = z.infer<typeof runManifest>;
export type Verification = z.infer<typeof verification>;
export type GitState = z.infer<typeof gitState>;
