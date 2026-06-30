import { z } from 'zod';
import { acgJourneyStep } from '~/schemas/acg-journey-spec';
import { isoDateTime, schemaVersion, workItemId } from '~/schemas/common';
import { journeyDslId, journeySurface } from '~/schemas/journey-dsl';

/**
 * Journey-authoring WORKING state (start → record → finalize), persisted per work
 * item. This is the pre-finalize draft buffer, NOT a published ACG catalog
 * artifact — the catalog shapes (acgJourneySpec/acgStorySpec) stay the source of
 * truth and are derived from these drafts at finalize. Overlapping pieces
 * (journeyDslId / journeySurface / acgJourneyStep) are imported from the canonical
 * schemas rather than redefined here (ADR-0002).
 */

const kebabSlug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case')
  .describe('Content-derived kebab identity; jrn-/us- ids and DSL filenames derive from it');

/** Journey step shape, derived from the canonical schema (ADR-0002). */
export type AcgJourneyStep = z.infer<typeof acgJourneyStep>;

/** A single journey being authored (drives one per-entity file + one DSL file). */
export const journeyDraft = z
  .object({
    slug: kebabSlug,
    name: z.string().min(1),
    description: z.string().min(1),
    owner: z.string().min(1),
    intent: z.string().min(1).describe('One-line user intent; the decompose source'),
    surfaces: z.array(journeySurface).min(1),
    steps: z.array(acgJourneyStep).default([]),
    implemented: z
      .boolean()
      .default(false)
      .describe('Does product code exist to resolve the selectors? false ⇒ spec_first (ac-6)'),
  })
  .describe('A journey draft recorded during authoring');

export type JourneyDraft = z.infer<typeof journeyDraft>;
/** Caller-facing input shape (pre-default: steps/implemented optional). */
export type JourneyDraftInput = z.input<typeof journeyDraft>;

/** A story being authored (surface ① story→journey→E2E). */
export const storyDraft = z
  .object({
    slug: kebabSlug,
    title: z.string().optional(),
    owner: z.string().min(1),
    actor: z.string().min(1),
    want: z.string().min(1),
    value: z.string().min(1),
    reference_journey_ids: z
      .array(journeyDslId)
      .default([])
      .describe(
        'Existing journeys (not newly created here) the story also owns — must exist (ac-8)',
      ),
  })
  .describe('A story draft recorded during authoring');

export type StoryDraft = z.infer<typeof storyDraft>;
/** Caller-facing input shape (pre-default: reference_journey_ids optional). */
export type StoryDraftInput = z.input<typeof storyDraft>;

export const journeyAuthoringState = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    kind: z.enum(['story', 'journey']).describe('Which authoring surface drives this session'),
    story: storyDraft.nullable().default(null),
    journeys: z.array(journeyDraft).default([]),
    finalized: z.object({ at: isoDateTime }).nullable().default(null),
    updated_at: isoDateTime,
  })
  .describe('Journey-authoring working state (pre-finalize draft buffer)');

export type JourneyAuthoringState = z.infer<typeof journeyAuthoringState>;
