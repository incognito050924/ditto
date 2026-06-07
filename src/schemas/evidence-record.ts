import { z } from 'zod';
import { evidenceRef, isoDateTime, schemaVersion, workItemId } from './common';

export const freshness = z
  .enum(['fresh', 'stale'])
  .describe('Whether the captured evidence still reflects the current state');

export const portability = z
  .enum(['committed', 'local-artifact'])
  .describe(
    'Whether the raw artifact travels with the repo (committed) or only exists in the capturing clone/session (local-artifact)',
  );

/**
 * Sidecar that wraps an `evidenceRef` with freshness/portability metadata
 * (설계서 §6.7 line 633-645). The point is to separate "증거가 있다" from "이
 * clone/세션에서 raw를 열 수 있다": a record can be judgeable from its summary /
 * sha256 / exit_code / key_lines even when the raw artifact is absent. The
 * underlying `evidenceRef` schema is reused verbatim — never widened here
 * (설계서 line 629).
 */
export const evidenceRecord = z
  .object({
    ref: evidenceRef,
    captured_at: isoDateTime,
    freshness: freshness,
    stale_reason: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe('Why the evidence is stale; required when freshness=stale, null when fresh'),
    portability: portability,
    artifact_available: z
      .boolean()
      .describe('True when the raw artifact can be opened in this clone/session'),
    exit_code: z
      .number()
      .int()
      .nullable()
      .default(null)
      .describe('Process exit code for command evidence; null for non-command kinds'),
    key_lines: z
      .array(z.string())
      .default([])
      .describe('Excerpt lines that make the evidence judgeable without the raw artifact'),
  })
  .superRefine((value, ctx) => {
    if (value.freshness === 'stale' && !value.stale_reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'freshness=stale requires a stale_reason',
        path: ['stale_reason'],
      });
    }
    if (value.freshness === 'fresh' && value.stale_reason !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'freshness=fresh must not carry a stale_reason (set it null)',
        path: ['stale_reason'],
      });
    }
    // 커밋된 증거는 정의상 이 clone/세션에서 열람 가능하다.
    if (value.portability === 'committed' && value.artifact_available !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'portability=committed implies artifact_available=true',
        path: ['artifact_available'],
      });
    }
  })
  .describe('Evidence freshness/portability sidecar wrapping an evidenceRef');

/**
 * Committable evidence ledger written to `.ditto/local/work-items/<id>/evidence-index.json`
 * (설계서 §8 layout). Append-only set of EvidenceRecords. Unlike the raw
 * `evidence/` directory (gitignored), this file is committed so other
 * clones/sessions can judge completion from metadata alone.
 */
export const evidenceIndex = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    records: z.array(evidenceRecord).default([]),
  })
  .describe('Committable evidence ledger (.ditto/local/work-items/<id>/evidence-index.json)');

export type EvidenceRecord = z.infer<typeof evidenceRecord>;
export type EvidenceIndex = z.infer<typeof evidenceIndex>;
