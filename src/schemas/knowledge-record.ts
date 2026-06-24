import { z } from 'zod';
import { evidenceRef, isoDateTime, relativePath, schemaVersion } from './common';

/**
 * KnowledgeContract (설계서 §6 line 144, §8 layout `.ditto/knowledge/`).
 *
 * Durable project knowledge: terms, decisions, repeated learnings. The
 * ubiquitous-language glossary keeps its own schema (`glossary.ts`); this record
 * references it by path rather than re-defining it (no shallow duplication).
 *
 * v0 status: this is a *design-locked contract* — the schema is registered, but
 * the KnowledgeCurator agent / `/ditto:knowledge-update` skill / CLAUDE.md
 * projection are post-v0 (M6) runtime (설계서 §0; M1.5b asserts the agent absent
 * in v0). See `reports/design/contracts/knowledge-contract.md`.
 */

const adrId = z
  .string()
  .regex(
    /^ADR-(?:\d{4}|\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*)$/,
    'ADR id must be legacy ADR-NNNN or new ADR-YYYYMMDD-slug (slug = lowercase alphanumeric words, hyphen-separated)',
  )
  .describe(
    'Architecture decision record id: legacy ADR-NNNN (e.g. ADR-0001) or new ADR-YYYYMMDD-slug (e.g. ADR-20260624-some-slug)',
  );

export const adrStatus = z
  .enum(['proposed', 'accepted', 'superseded', 'deprecated'])
  .describe('Lifecycle of an architecture decision');

export const knowledgeDecision = z
  .object({
    id: adrId,
    title: z.string().min(1),
    status: adrStatus,
    rationale: z.string().min(1).describe('Why the decision was made (근거)'),
    change_condition: z
      .string()
      .min(1)
      .describe(
        'Under what conditions the decision should be revisited (변경 조건, 설계서 line 786)',
      ),
    path: relativePath.describe('Repo-relative path to the ADR document'),
    superseded_by: adrId.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'superseded' && value.superseded_by === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'status=superseded requires superseded_by (the ADR that replaces it)',
        path: ['superseded_by'],
      });
    }
    // superseded_by must point at *another* ADR — an ADR cannot supersede itself.
    if (value.superseded_by !== null && value.superseded_by === value.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'superseded_by must be a different ADR id, not the decision itself',
        path: ['superseded_by'],
      });
    }
  })
  .describe('One durable technical decision with rationale and change condition');

export const knowledgePattern = z
  .object({
    name: z.string().min(1),
    summary: z.string().min(1).describe('What the reusable pattern is and when it applies'),
    path: relativePath.optional(),
  })
  .describe('A reusable implementation/process pattern promoted to durable knowledge');

export const knowledgeLearning = z
  .object({
    summary: z.string().min(1).describe('What was learned, in reusable terms'),
    evidence: z.array(evidenceRef).default([]),
    learned_at: isoDateTime,
  })
  .describe('A repeated learning worth carrying across work items (반복 학습)');

export const knowledgeRecord = z
  .object({
    schema_version: schemaVersion,
    project_name: z.string().min(1),
    updated_at: isoDateTime,
    context_path: relativePath
      .default('.ditto/knowledge/CONTEXT.md')
      .describe('Prose project context'),
    glossary_path: relativePath
      .default('.ditto/knowledge/glossary.json')
      .describe('Ubiquitous-language glossary; validated by the separate glossary schema'),
    project_map_path: relativePath.nullable().default(null),
    decisions: z.array(knowledgeDecision).default([]),
    patterns: z.array(knowledgePattern).default([]),
    learnings: z.array(knowledgeLearning).default([]),
    projected_to_claude_md: z
      .boolean()
      .default(false)
      .describe('Whether this knowledge has been projected into CLAUDE.md (M6 runtime)'),
  })
  .describe('Index of durable project knowledge (.ditto/knowledge/), excluding the glossary body');

export type KnowledgeRecord = z.infer<typeof knowledgeRecord>;
export type KnowledgeDecision = z.infer<typeof knowledgeDecision>;
