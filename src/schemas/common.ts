import { z } from 'zod';

export const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .describe('RFC 3339 / ISO 8601 datetime with timezone offset');

export const workItemId = z
  .string()
  .regex(
    /^wi_[a-z0-9]{8,}$/,
    'work item id must start with wi_ followed by 8+ lowercase alphanumerics',
  )
  .describe('Stable identifier for a work item');

export const runId = z
  .string()
  .regex(/^run_[a-z0-9]{8,}$/, 'run id must start with run_ followed by 8+ lowercase alphanumerics')
  .describe('Stable identifier for a single provider run');

export const reviewId = z
  .string()
  .regex(
    /^rv_[a-z0-9]{8,}$/,
    'review id must start with rv_ followed by 8+ lowercase alphanumerics',
  )
  .describe('Stable identifier for a reviewer output');

export const autopilotId = z
  .string()
  .regex(
    /^orch_[a-z0-9]{8,}$/,
    'autopilot id must start with orch_ followed by 8+ lowercase alphanumerics',
  )
  .describe('Stable identifier for an autopilot graph (orchestrator run)');

export const profileName = z
  .enum(['read-only', 'workspace-write', 'networked', 'reviewer', 'isolated'])
  .describe('Execution profile that determines permission and network policy');

export const declarerRole = z
  .enum(['main', 'planner', 'implementer', 'verifier', 'reviewer', 'researcher', 'synthesizer'])
  .describe(
    'Agent role that authored a completion claim (who judged), distinct from the execution profile (how it ran)',
  );

export const providerName = z
  .enum(['codex', 'claude-code', 'opencode', 'openagent', 'other'])
  .describe('Provider host that executes the run');

export const verdict = z
  .enum(['pass', 'partial', 'fail', 'unverified'])
  .describe('Acceptance verdict for a criterion or review');

export const workItemStatus = z
  .enum(['draft', 'in_progress', 'blocked', 'partial', 'unverified', 'done', 'abandoned'])
  .describe('Current lifecycle status of a work item');

export const severity = z
  .enum(['info', 'low', 'medium', 'high', 'critical'])
  .describe('Finding severity');

export const sha256 = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 lowercase hex characters')
  .describe('Lowercase hex sha256 hash');

export const relativePath = z
  .string()
  .min(1)
  .refine((s) => !s.startsWith('/') && !s.includes('..'), {
    message: 'must be repo-relative without parent traversal',
  })
  .describe('Repo-relative path; absolute paths and .. traversal are rejected');

export const evidenceRef = z
  .object({
    kind: z.enum(['command', 'file', 'artifact', 'url', 'note']),
    path: relativePath.optional(),
    url: z.string().url().optional(),
    command: z.string().optional(),
    sha256: sha256.optional(),
    lines: z
      .object({ start: z.number().int().positive(), end: z.number().int().positive() })
      .optional(),
    summary: z.string().max(2000).optional(),
  })
  .describe('Pointer to evidence stored outside the manifest itself');

// A single declared uncertainty: what is unresolved and why. Shared base
// primitive (wi_260627jhh) reused by the owner-return envelope (`uncertainty[]`)
// and the completion contract's `unverified[]` (which EXTENDS it with the
// resolvability/grounding/out_of_scope fields the gate routes on). It lives here
// in common.ts — not in completion-contract.ts where the richer shape lives — so
// the envelope can reuse it WITHOUT an import cycle (envelope → completion-contract
// would be one; common.ts depends on nothing in either).
export const uncertaintyItem = z
  .object({
    item: z.string().min(1).describe('What is unresolved / was not verified'),
    reason: z.string().min(1).describe('Why it remains open / why verification did not happen'),
  })
  .describe('A single declared uncertainty: what is unresolved and why');

export const schemaVersion = z
  .literal('0.1.0')
  .describe('Version of the DITTO schema set this document conforms to');
