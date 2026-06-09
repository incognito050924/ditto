import { z } from 'zod';
import { isoDateTime, relativePath, schemaVersion, sha256 } from './common';

export const memorySourceId = z
  .string()
  .regex(
    /^src_[a-z0-9_-]{4,}$/,
    'source id must start with src_ followed by 4+ lowercase alphanumerics, underscore, or hyphen',
  )
  .describe('Stable identifier for a raw source captured into memory');

export const memorySourceType = z
  .enum(['code', 'markdown', 'spec', 'note', 'log', 'chat', 'image', 'other'])
  .describe('Kind of raw source');

export const memorySensitivity = z
  .enum(['public', 'internal', 'secret'])
  .describe('Disclosure class of a source or memory event');

const gitCommit = z
  .string()
  .regex(/^[a-f0-9]{40}$/, 'git commit must be 40 lowercase hex characters')
  .describe('Full git commit sha, when the source is git-managed');

export const memorySource = z
  .object({
    schema_version: schemaVersion,
    source_id: memorySourceId,
    source_type: memorySourceType,
    path: relativePath.optional().describe('Repo-relative path for file-backed sources'),
    url: z.string().url().optional().describe('Location for url-backed sources'),
    content_hash: sha256.describe('Hash of the captured content; drives stale detection'),
    captured_at: isoDateTime,
    revision: z
      .string()
      .min(1)
      .describe('git commit, file mtime, or snapshot id identifying this source version'),
    git_commit: gitCommit.optional(),
    sensitivity: memorySensitivity.default('internal'),
    word_count: z.number().int().nonnegative().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.path && !value.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a source must have either a path or a url',
        path: ['path'],
      });
    }
  })
  .describe(
    'Manifest entry for one raw source — the mutable reality memory projects from (report §3.1)',
  );

export type MemorySource = z.infer<typeof memorySource>;
