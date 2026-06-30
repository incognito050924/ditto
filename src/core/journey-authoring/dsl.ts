import { type JourneyFrontMatter, journeyFrontMatter } from '~/schemas/journey-dsl';
import type { AcgJourneyStep } from './session-state';

/**
 * Render a journey DSL document (`e2e/journeys/<slug>.journey.md`) from a journey
 * spec (ac-2). Front-matter is validated through `journeyFrontMatter` (ADR-0002)
 * before serialization; the body lists the steps as `N. [step_id] <intent>` —
 * the structural form `extractStepIds` reads back. Deterministic: same input →
 * byte-identical output, so re-finalize overwrites with the same bytes (ac-3).
 */
export function renderJourneyDsl(input: {
  id: string;
  name: string;
  description: string;
  surfaces: string[];
  steps: AcgJourneyStep[];
}): string {
  const front: JourneyFrontMatter = journeyFrontMatter.parse({
    ditto_journey: 'v1',
    id: input.id,
    name: input.name,
    description: input.description,
    surfaces: input.surfaces,
    uses_blocks: [],
    flaky_history: [],
  });

  const lines: string[] = ['---', 'ditto_journey: v1', `id: ${front.id}`, `name: ${front.name}`];
  lines.push(`description: ${front.description}`);
  lines.push('surfaces:');
  for (const s of front.surfaces) lines.push(`  - ${s}`);
  lines.push('uses_blocks: []');
  lines.push('flaky_history: []');
  lines.push('---');
  lines.push('');
  input.steps.forEach((step, i) => {
    lines.push(`${i + 1}. [${step.step_id}] ${step.intent}`);
  });
  lines.push('');
  return lines.join('\n');
}
