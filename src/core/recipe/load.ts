import { join } from 'node:path';
import { localDir } from '~/core/ditto-paths';
import type { Recipe } from '~/schemas/recipe';
import { parseRecipe } from './parse';

/**
 * Whether a recipe was EXPLICITLY requested (a `--recipe <path>` flag) or
 * AUTO-DISCOVERED at a conventional location. This decides the malformed policy
 * (ac-5): explicit → hard error; discovered → fail-open with a warning.
 */
export type RecipeSourceKind = 'explicit' | 'discovered';

/** Conventional checked-in project recipe — repo-root `recipe.yaml` (tier ②, git-shared). */
export const PROJECT_RECIPE_FILENAME = 'recipe.yaml';

/**
 * Built-in default recipe (lowest precedence). Empty by design: the effective
 * wizard defaults (e.g. host=claude-code) stay owned by the wizard/wiring node —
 * the recipe layer only carries EXPLICIT overrides, so an absent recipe changes
 * nothing.
 */
export const BUILTIN_DEFAULT_RECIPE: Recipe = {};

export interface RecipeSources {
  /** CLI flag — highest precedence. */
  cli?: Recipe | undefined;
  /** Personal recipe under `.ditto/local` (ADR-0012, gitignored). */
  personal?: Recipe | undefined;
  /** Checked-in project recipe (repo-root `recipe.yaml`). */
  project?: Recipe | undefined;
  /** Built-in default — lowest precedence. */
  builtinDefault?: Recipe | undefined;
}

/** Only the keys the source actually set (zod strips absent keys, so undefined values are dropped). */
function definedFields(r: Recipe): Partial<Recipe> {
  return Object.fromEntries(
    Object.entries(r).filter(([, v]) => v !== undefined),
  ) as Partial<Recipe>;
}

/**
 * Per-field merge: `override` replaces ONLY the fields it sets; every other field
 * of `base` survives (granular, NOT whole-file replace). Matches the precedence
 * style of resolveQuestionConfig (src/core/tech-spec-options.ts).
 */
export function mergeRecipes(base: Recipe, override: Recipe): Recipe {
  return { ...base, ...definedFields(override) };
}

/**
 * Resolve the effective recipe from all sources by priority
 * `cli > personal > project > builtinDefault`, folding low→high so a higher source
 * overrides per field (ac-4). Absent sources are skipped.
 */
export function resolveRecipe(sources: RecipeSources): Recipe {
  return [sources.builtinDefault, sources.project, sources.personal, sources.cli]
    .filter((r): r is Recipe => r !== undefined)
    .reduce<Recipe>((acc, r) => mergeRecipes(acc, r), {});
}

/**
 * Load + validate a single recipe file with the source-keyed malformed policy
 * (ac-5).
 *
 * - `explicit`: a missing file OR a parse/validate failure is a HARD ERROR
 *   (throws) — an explicitly-requested recipe must never silently no-op.
 * - `discovered`: a missing file → `undefined` silently; a parse/validate failure
 *   → `undefined` plus an `onMalformed` warning (mirrors ditto-config.ts fail-open)
 *   so a broken auto-discovered recipe is not silently ignored.
 */
export async function loadRecipeFile(
  path: string,
  source: RecipeSourceKind,
  onMalformed?: (message: string) => void,
): Promise<Recipe | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    if (source === 'explicit') {
      throw new Error(`recipe not found at explicit path: ${path}`);
    }
    return undefined;
  }
  const result = parseRecipe(await file.text());
  if (!result.ok) {
    if (source === 'explicit') {
      throw new Error(`${result.error} (${path})`);
    }
    onMalformed?.(`${result.error} (${path})`);
    return undefined;
  }
  return result.recipe;
}

/**
 * Discover + resolve the effective recipe for a repo. Reads the conventional
 * project recipe (`<repoRoot>/recipe.yaml`) and personal recipe
 * (`.ditto/local/recipe.yaml`) as DISCOVERED (fail-open warn), and an optional
 * `cliPath` as EXPLICIT (hard error on malformed/missing), then merges per field
 * by priority `cli > personal > project > builtinDefault`.
 *
 * `onMalformed(origin, message)` surfaces a fail-open warning naming WHICH
 * discovered recipe was malformed (`project` | `personal`) so the CLI can tell the
 * user which file was ignored; the CLI keeps the stderr side-effect (mirrors
 * ditto-config.ts).
 */
export type DiscoveredRecipeOrigin = 'project' | 'personal';

export async function loadResolvedRecipe(
  repoRoot: string,
  cliPath: string | undefined,
  onMalformed?: (origin: DiscoveredRecipeOrigin, message: string) => void,
): Promise<Recipe> {
  const project = await loadRecipeFile(join(repoRoot, PROJECT_RECIPE_FILENAME), 'discovered', (m) =>
    onMalformed?.('project', m),
  );
  const personal = await loadRecipeFile(localDir(repoRoot, 'recipe.yaml'), 'discovered', (m) =>
    onMalformed?.('personal', m),
  );
  const cli = cliPath === undefined ? undefined : await loadRecipeFile(cliPath, 'explicit');

  return resolveRecipe({ cli, personal, project, builtinDefault: BUILTIN_DEFAULT_RECIPE });
}
