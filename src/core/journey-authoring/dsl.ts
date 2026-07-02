import { stringify as stringifyYaml } from 'yaml';
import { type JourneyFrontMatter, journeyFrontMatter } from '~/schemas/journey-dsl';
import type { AcgJourneyStep } from './session-state';

/**
 * Render a journey DSL document (`e2e/journeys/<slug>.journey.md`) from a journey
 * spec (ac-2). Emits DSL v2 (wi_2607026qs, clean break): the rich, machine-
 * validatable context lives in the front-matter, validated through
 * `journeyFrontMatter` (ADR-0002) and serialized with the same YAML round-trip
 * the digest/verdict paths use (journey-digest.ts) so the emitted file re-parses
 * byte-stably. The body stays STRUCTURAL-ONLY — `N. [step_id] <intent>` — the
 * form `extractStepIds` reads back; body semantics remain human-authored
 * (design boundary, ADR-0014). Deterministic: same input → byte-identical
 * output, so re-finalize overwrites with the same bytes (ac-3).
 *
 * `implementation_intent` (required in v2 → the plan Application Overview) is
 * DERIVED from the two prose fields the authoring session already holds: the
 * journey `description` (its purpose/value) followed by the one-line `intent`
 * (its concrete flow). The rich-context fields v2 adds (constraints, edge/
 * failure cases, auth/initial_state/seed) are not part of the authoring draft,
 * so they fall to the schema defaults — empty arrays and omitted optionals.
 */
export function renderJourneyDsl(input: {
  id: string;
  name: string;
  description: string;
  intent: string;
  surfaces: string[];
  steps: AcgJourneyStep[];
}): string {
  const front: JourneyFrontMatter = journeyFrontMatter.parse({
    ditto_journey: 'v2',
    id: input.id,
    name: input.name,
    description: input.description,
    surfaces: input.surfaces,
    implementation_intent: `${input.description} — ${input.intent}`,
  });

  const body = input.steps
    .map((step, i) => `${i + 1}. [${step.step_id}] ${step.intent}`)
    .join('\n');

  return `---\n${stringifyYaml(front)}---\n\n${body}\n`;
}
