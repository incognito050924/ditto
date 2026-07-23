import { z } from 'zod';

import { memorySensitivity } from './memory-event';

/**
 * Memory source — one per-entity JSON file under `.ditto/memory/sources/`
 * (git-tracked SoT). A source is the provenance record behind events: what
 * file/url the fact came from, at which content hash and revision. The
 * `content_hash` drives stale detection; `git_commit` (when the source lives
 * in a git repo) drives the code↔SoT drift axis.
 */

export const memorySourceType = z
  .enum(['code', 'markdown', 'spec', 'note', 'log', 'chat', 'image', 'other'])
  .describe('What kind of artifact the source is');

const SOURCE_ID_RE = /^src_[a-z0-9_-]{4,}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_COMMIT_RE = /^[a-f0-9]{40}$/;

export const memorySource = z
  .object({
    schema_version: z.string().min(1),
    source_id: z.string().regex(SOURCE_ID_RE),
    source_type: memorySourceType,
    path: z.string().min(1).optional().describe('Repo-relative path of the artifact'),
    url: z.string().min(1).optional(),
    content_hash: z
      .string()
      .regex(SHA256_RE)
      .describe('sha256 of the captured content — drives stale detection'),
    captured_at: z.string().min(1),
    repo: z
      .string()
      .min(1)
      .optional()
      .describe('Owning repo (multi-repo); omitted for the root repo'),
    revision: z
      .string()
      .min(1)
      .describe('git commit, file mtime, or snapshot:<hash> id at capture time'),
    git_commit: z.string().regex(GIT_COMMIT_RE).optional(),
    sensitivity: memorySensitivity.default('internal'),
    word_count: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    if (source.path === undefined && source.url === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a source needs at least one of path or url',
      });
    }
  })
  .describe('One memory source (per-entity SoT provenance file)');

export type MemorySource = z.infer<typeof memorySource>;
export type MemorySourceType = z.infer<typeof memorySourceType>;
