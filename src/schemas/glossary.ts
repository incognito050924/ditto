import { z } from 'zod';
import { isoDateTime, schemaVersion } from './common';

export const glossaryStatus = z
  .enum(['proposed', 'agreed', 'deprecated'])
  .describe('Lifecycle of a glossary entry');

export const glossaryEntry = z
  .object({
    term: z
      .string()
      .min(1)
      .max(80)
      .describe('Canonical surface form of the term as used with the user'),
    aliases: z
      .array(z.string().min(1))
      .default([])
      .describe('Other surface forms users or agents have used; self-check matches them too'),
    definition: z
      .string()
      .min(1)
      .max(800)
      .describe('What the term means in this project; written so an outsider can understand'),
    examples: z.array(z.string()).default([]).describe('Concrete usage examples'),
    not_to_be_confused_with: z
      .array(z.string())
      .default([])
      .describe('Adjacent terms that have caused confusion'),
    status: glossaryStatus.default('agreed'),
    forbidden_abbreviations: z
      .array(z.string())
      .default([])
      .describe('Abbreviations that self-check should reject in user-facing output'),
    proposed_at: isoDateTime.optional(),
    agreed_at: isoDateTime.optional(),
    deprecated_at: isoDateTime.optional(),
  })
  .describe('One ubiquitous-language entry shared between user and agents');

export const glossary = z
  .object({
    schema_version: schemaVersion,
    project_name: z.string().min(1),
    updated_at: isoDateTime,
    entries: z.array(glossaryEntry).default([]),
  })
  .describe('Machine-readable view of .ditto/knowledge/CONTEXT.md');

export type Glossary = z.infer<typeof glossary>;
export type GlossaryEntry = z.infer<typeof glossaryEntry>;
