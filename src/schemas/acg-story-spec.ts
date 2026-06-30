import { z } from 'zod';
import { acgCatalogEnvelope } from './acg-common';
import { journeyDslId } from './journey-dsl';

/**
 * ACG StorySpec — first-class spec of a user story. A per-repo catalog entry
 * (like JourneySpec/ArchitectureSpec; no work_item_id). A story owns one or more
 * journeys (1:N): it carries the "As a / I want / so that" value narrative and
 * points at the `jrn-` journeys that realize it. JourneySpec carries the inverse
 * `story_id` back-link so the anchor is traceable both ways.
 */

const kebab = '[a-z0-9]+(?:-[a-z0-9]+)*';

export const storySpecId = z
  .string()
  .regex(new RegExp(`^us-${kebab}$`), 'story id must be us-<kebab-case>')
  .describe('Story id: us- prefix + kebab-case (machine identity other schemas reference)');

export const acgStorySpec = z
  .object({
    ...acgCatalogEnvelope('acg.story-spec.v1'),
    id: storySpecId,
    title: z.string().optional(),
    owner: z.string().min(1).describe('Product owner of the story — freshness/judgment subject'),
    actor: z.string().min(1).describe('"As a <actor>" — who the story serves'),
    want: z.string().min(1).describe('"I want <want>" — the capability the actor seeks'),
    value: z.string().min(1).describe('"so that <value>" — the value the capability delivers'),
    journey_ids: z
      .array(journeyDslId)
      .min(1)
      .describe('Journeys (jrn- ids) that realize this story — story→journey is 1:N'),
  })
  .describe('ACG StorySpec — first-class user-story catalog entry (owns journeys 1:N)');

export type AcgStorySpec = z.infer<typeof acgStorySpec>;
