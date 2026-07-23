import { z } from 'zod';

/**
 * Glossary — the machine-readable ubiquitous-language index under
 * `.ditto/knowledge/glossary.json`. Which terms are "agreed" (promotion
 * judgment) stays with the LLM curator; this schema owns only the shape.
 * Strict: unknown keys are rejected so silent field drift surfaces instead of
 * being quietly dropped.
 */

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
    proposed_at: z.string().min(1).optional(),
    agreed_at: z.string().min(1).optional(),
    deprecated_at: z.string().min(1).optional(),
  })
  .strict()
  .describe('One ubiquitous-language entry shared between user and agents');

export const glossary = z
  .object({
    schema_version: z.string().min(1),
    project_name: z.string().min(1),
    updated_at: z.string().min(1),
    entries: z.array(glossaryEntry).default([]),
  })
  .strict()
  .describe('The glossary file: the term index projected into CLAUDE.md');

export type GlossaryStatus = z.infer<typeof glossaryStatus>;
export type Glossary = z.infer<typeof glossary>;
export type GlossaryEntry = z.infer<typeof glossaryEntry>;
