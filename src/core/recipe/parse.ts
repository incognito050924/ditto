import { parse as parseYamlText } from 'yaml';
import { type Recipe, recipe } from '~/schemas/recipe';

/**
 * Result of parsing one recipe document. The policy of what to DO with an error
 * (hard-fail vs. fail-open warn) lives in the loader (see load.ts), keyed on
 * whether the recipe was explicitly requested or auto-discovered. This function
 * stays a pure parser: yaml parse → zod validate.
 */
export type RecipeParseResult = { ok: true; recipe: Recipe } | { ok: false; error: string };

/**
 * Parse + validate a recipe document. Uses the already-present `yaml` parser
 * (yaml@2, the safe parser — no second parser added). An empty document parses
 * to an empty recipe (all fields optional). A non-mapping document (bare scalar /
 * list) or a schema-invalid value (ac-4 enums) yields `{ ok: false }`.
 */
export function parseRecipe(text: string): RecipeParseResult {
  let raw: unknown;
  try {
    raw = parseYamlText(text);
  } catch (error) {
    return { ok: false, error: `recipe YAML parse failed: ${describe(error)}` };
  }
  // Empty / whitespace-only document → treat as an empty recipe, not malformed.
  const candidate = raw === undefined || raw === null ? {} : raw;
  const parsed = recipe.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: `recipe schema validation failed: ${parsed.error.message}` };
  }
  return { ok: true, recipe: parsed.data };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
