import { z } from 'zod';
import { schemaVersion } from './common';
import { journeyDslId } from './journey-dsl';

/**
 * Assertion map (wi_2607026qs, Contract 4 / ac-6).
 *
 * The map records, per journey `확인:` (confirm) step, how faithfully the
 * generator's emitted Playwright matcher reproduces the DSL assertion's
 * semantics. It is the human-review + gate surface for the DSL→plan→spec
 * pipeline: a DROPPED assertion (`unmapped`) is a hard-fail, a WEAKENED one
 * (`weaker`) is a flagged non-fatal signal, and a STRONGER one is flagged too
 * (the generator asserted more than the author declared). Both the DSL text and
 * the emitted assertion are stored REDACTED (Contract 6) because the machine
 * JSON and the derived human doc are read/committed. ADR-0002: schema SoT lives
 * here in src/schemas.
 */

/** The five DSL confirm forms the author may declare. */
export const assertionDslForm = z
  .enum(['contains', 'visible', 'hidden', 'present', 'url-contains'])
  .describe('DSL 확인 form: contains | visible | hidden | present | url-contains');

export type AssertionDslForm = z.infer<typeof assertionDslForm>;

/**
 * How the emitted matcher relates to the DSL assertion.
 *  - exact:    faithful reproduction of the declared semantics
 *  - weaker:   emitted asserts LESS than declared (e.g. contains → only visible)
 *  - stronger: emitted asserts MORE than declared (e.g. contains → exact text)
 *  - unmapped: no expect(...) reproduces the confirm step (dropped assertion)
 */
export const assertionStrength = z
  .enum(['exact', 'weaker', 'stronger', 'unmapped'])
  .describe('Relation of emitted matcher to DSL assertion');

export type AssertionStrength = z.infer<typeof assertionStrength>;

export const assertionMapEntry = z
  .object({
    journey_id: journeyDslId,
    step_id: z.string().min(1).describe('DSL step id (sN) this confirm assertion belongs to'),
    dsl_assertion: z
      .string()
      .min(1)
      .describe('The DSL 확인 clause (REDACTED — secret values masked to <env:VAR>)'),
    dsl_form: assertionDslForm,
    emitted_assertion: z
      .string()
      .describe('The emitted expect(...) statement (REDACTED); empty when unmapped'),
    emitted_matcher: z
      .string()
      .describe('The Playwright matcher name (e.g. toContainText); empty when unmapped'),
    strength: assertionStrength,
    flag: z.boolean().describe('True whenever strength !== exact (needs human review)'),
    note: z
      .string()
      .min(1)
      .optional()
      .describe('Why the entry is flagged (weakened/strengthened/dropped rationale)'),
  })
  .strict()
  .describe('One DSL confirm step mapped to its emitted assertion');

export type AssertionMapEntry = z.infer<typeof assertionMapEntry>;

export const assertionMap = z
  .object({
    schema_version: schemaVersion,
    work_item_id: z.string().min(1).describe('Work item the map was built for'),
    journey_id: journeyDslId,
    generated_spec: z.string().min(1).describe('Repo-relative path of the generated spec analysed'),
    entries: z.array(assertionMapEntry).describe('One entry per DSL 확인 step (recognised form)'),
    weakened_count: z.number().int().nonnegative().describe('Count of strength === weaker entries'),
    unmapped_count: z
      .number()
      .int()
      .nonnegative()
      .describe('Count of strength === unmapped entries (any > 0 → hard-fail gate)'),
  })
  .strict()
  .describe('Assertion map (.ditto/local/work-items/<wi>/e2e-assertion-map.json)');

export type AssertionMap = z.infer<typeof assertionMap>;
