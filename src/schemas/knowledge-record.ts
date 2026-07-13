import { z } from 'zod';
import { evidenceRef, isoDateTime, relativePath, schemaVersion } from './common';

/**
 * KnowledgeContract (설계서 §6 line 144, §8 layout `.ditto/knowledge/`).
 *
 * Durable project knowledge: terms, repeated learnings, reusable patterns. The
 * ubiquitous-language glossary keeps its own schema (`glossary.ts`); this record
 * references it by path rather than re-defining it (no shallow duplication).
 *
 * Architecture decisions live as `.ditto/knowledge/adr/*.md` files (the SoT); the
 * structured decision graph (rationale/supersedes-chain/ontology) is homed in the
 * external memory project (ADR-0021), not re-indexed here — a hand-maintained
 * `decisions[]` index was retired as drift-prone duplication (ADR-20260624 amend,
 * wi_2606247cx). At inference time ADRs reach agents via the memory event graph
 * (`adrGist`), not this record (ADR-0020 D4).
 *
 * v0 status: this is a *design-locked contract* — the schema is registered, but
 * the KnowledgeCurator agent / `/ditto:knowledge-update` skill / CLAUDE.md
 * projection are post-v0 (M6) runtime (설계서 §0; M1.5b asserts the agent absent
 * in v0).
 */

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
    patterns: z.array(knowledgePattern).default([]),
    learnings: z.array(knowledgeLearning).default([]),
    projected_to_claude_md: z
      .boolean()
      .default(false)
      .describe('Whether this knowledge has been projected into CLAUDE.md (M6 runtime)'),
  })
  .describe('Index of durable project knowledge (.ditto/knowledge/), excluding the glossary body');

export type KnowledgeRecord = z.infer<typeof knowledgeRecord>;
