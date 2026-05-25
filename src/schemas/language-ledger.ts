import { z } from 'zod';
import { isoDateTime, schemaVersion, workItemId } from './common';

export const languageChange = z
  .object({
    op: z
      .enum(['add', 'modify', 'deprecate', 'alias'])
      .describe('What kind of glossary change this entry records'),
    term: z.string().min(1),
    before: z.string().optional().describe('Prior definition or surface form, if applicable'),
    after: z.string().optional().describe('New definition or surface form, if applicable'),
    rationale: z
      .string()
      .min(1)
      .describe('Why the change is needed; cite user statement when available'),
    proposed_by: z.string().min(1).describe('User handle or agent profile that proposed it'),
    agreed_with_user: z
      .boolean()
      .describe('True only after explicit user confirmation; defaults to false on creation'),
    decided_at: isoDateTime.optional(),
  })
  .describe('One change to project language as observed during a work item');

export const languageLedger = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    created_at: isoDateTime,
    updated_at: isoDateTime,
    changes: z.array(languageChange).default([]),
  })
  .describe('Per-work-item record of language negotiations; merged into glossary once agreed');

export type LanguageLedger = z.infer<typeof languageLedger>;
export type LanguageChange = z.infer<typeof languageChange>;
