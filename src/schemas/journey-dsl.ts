import { z } from 'zod';

/**
 * Journey DSL v1 front-matter (wi_260610p9h, 확정 DSL 설계 v1 — 사용자 승인).
 *
 * Source files live under `e2e/journeys/<slug>.journey.md` (blocks under
 * `e2e/journeys/blocks/<block-id>.block.md`) with a YAML front-matter block.
 * These schemas validate ONLY the front-matter; the markdown body is read for
 * step ids alone (`src/core/e2e/journey-dsl.ts`) — body semantics stay with the
 * authoring agent, never the machine (design boundary).
 */

const kebab = '[a-z0-9]+(?:-[a-z0-9]+)*';

export const journeyDslId = z
  .string()
  .regex(new RegExp(`^jrn-${kebab}$`), 'journey id must be jrn-<kebab-case>')
  .describe('Journey id: jrn- prefix + kebab-case (machine identity of the journey)');

// Surfaces declare WHERE the journey touches the product, with exactly 3 forms:
// `page:<path>` / `api:<METHOD> <path>` / `component:<repo path|glob>`.
const surfacePattern = /^(?:page:\S.*|api:[A-Z]+ \S.*|component:\S.*)$/;

export const journeySurface = z
  .string()
  .regex(
    surfacePattern,
    'surface must be page:<path> | api:<METHOD> <path> | component:<repo path|glob>',
  )
  .describe('A product surface the journey touches (page:/api:/component: prefixed)');

export const flakyHistoryEntry = z
  .object({
    date: z.string().min(1).describe('When the flake was observed (e.g. 2026-06-01)'),
    case: z.string().min(1).describe('Which case/step flaked'),
    note: z.string().min(1).describe('Context for the next author (env, suspicion, workaround)'),
  })
  .describe('One recorded flaky occurrence of this journey');

export const journeyFrontMatter = z
  .object({
    ditto_journey: z
      .literal('v1')
      .describe('Literal DSL marker + version; how a journey file is mechanically identified'),
    id: journeyDslId,
    name: z.string().min(1).describe('Human-facing journey name'),
    description: z.string().min(1).describe('Purpose/value of the journey'),
    surfaces: z.array(journeySurface).min(1).describe('Surfaces the journey touches (≥1)'),
    uses_blocks: z
      .array(z.string().min(1))
      .default([])
      .describe('Block ids (blocks/<id>.block.md) this journey composes'),
    flaky_history: z.array(flakyHistoryEntry).default([]).describe('Recorded flaky occurrences'),
  })
  .describe('Front-matter of an e2e/journeys/<slug>.journey.md file (DSL v1)');

export type JourneyFrontMatter = z.infer<typeof journeyFrontMatter>;

export const blockFrontMatter = z
  .object({
    ditto_block: z
      .literal('v1')
      .describe('Literal DSL marker + version; how a block file is mechanically identified'),
    id: z.string().min(1).describe('Block id (= blocks/<id>.block.md filename stem)'),
    name: z.string().min(1).describe('Human-facing block name'),
    params: z.array(z.string().min(1)).default([]).describe('Parameter names the block accepts'),
  })
  .describe('Front-matter of an e2e/journeys/blocks/<block-id>.block.md file (DSL v1)');

export type BlockFrontMatter = z.infer<typeof blockFrontMatter>;
