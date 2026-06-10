import { extractStepMarkers, parseBlockDoc, parseJourneyDoc } from './journey-dsl';

/**
 * DSL ↔ generated-spec step conformance (wi_260610p9h ac-3).
 *
 * The agent performs the conversion (no deterministic transformer — design
 * boundary §5-12); the machine's job here is the GATE: every step id declared
 * in the journey body (and in every block listed in `uses_blocks`) must appear
 * as a `// @step <owner-id>/<step-id>` marker somewhere in the generated spec
 * or its support helpers. A missing correspondence is a failure, never a
 * warning — that is what makes traceability mechanical.
 */

export interface ConformanceInput {
  /** Full text of the <slug>.journey.md document. */
  journeyText: string;
  /** Block doc texts keyed by the id used in the journey's uses_blocks. */
  blockTexts: Record<string, string>;
  /** Full text of the generated <slug>.spec.ts. */
  generatedText: string;
  /** Texts of the generated support helpers the spec imports. */
  supportTexts: string[];
}

export interface ConformanceReport {
  ok: boolean;
  /** `<owner-id>/<step-id>` refs the DSL requires (journey order, then blocks). */
  required: string[];
  /** Marker refs found in the generated spec + support helpers (deduped). */
  found: string[];
  /** Required refs with no marker — each one is a broken traceability link. */
  missing: string[];
  /** Parse/lookup failures (unreadable front-matter, undeclared block, …). */
  errors: string[];
}

export function checkStepConformance(input: ConformanceInput): ConformanceReport {
  const errors: string[] = [];
  const required: string[] = [];

  const journey = parseJourneyDoc(input.journeyText);
  if (!journey.ok) {
    errors.push(`journey: ${journey.error}`);
  } else {
    // Zero extracted step ids → required would be empty and a marker-less spec
    // would pass vacuously. An empty step set is a conformance failure.
    if (journey.stepIds.length === 0) {
      errors.push(
        `journey "${journey.frontMatter.id}": body declares no step id ([sN]) — nothing to trace, vacuous pass refused`,
      );
    }
    required.push(...journey.stepIds.map((id) => `${journey.frontMatter.id}/${id}`));
    for (const blockId of journey.frontMatter.uses_blocks) {
      const text = input.blockTexts[blockId];
      if (text === undefined) {
        errors.push(`block "${blockId}" is declared in uses_blocks but no block file was found`);
        continue;
      }
      const block = parseBlockDoc(text);
      if (!block.ok) {
        errors.push(`block "${blockId}": ${block.error}`);
        continue;
      }
      if (block.stepIds.length === 0) {
        errors.push(
          `block "${blockId}": body declares no step id ([bN]) — nothing to trace, vacuous pass refused`,
        );
        continue;
      }
      required.push(...block.stepIds.map((id) => `${block.frontMatter.id}/${id}`));
    }
  }

  const found = [
    ...new Set([
      ...extractStepMarkers(input.generatedText),
      ...input.supportTexts.flatMap(extractStepMarkers),
    ]),
  ];
  const missing = required.filter((ref) => !found.includes(ref));
  return { ok: errors.length === 0 && missing.length === 0, required, found, missing, errors };
}
