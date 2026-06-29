import { z } from 'zod';
import { nodeOwner } from './autopilot';

/**
 * `recipe.yaml` schema — a headless declaration of the four `ditto setup` wizard
 * stages so setup can run non-interactively (wi_2606287lb). ADR-0002: zod is the
 * source of truth for the shape. Every field is OPTIONAL — a partial recipe is
 * valid and only overrides the stages it names (the loader merges per-field).
 *
 * ac-4: host / agent-role / memory are `z.enum(...)` against the CANONICAL sets,
 * NOT `z.string()`. A semantically-invalid value (e.g. `host: gitlab`) must FAIL
 * validation rather than flow through as dead config the wizard cannot honor.
 */

/** Install target — mirrors parseSetupHost in src/cli/commands/setup.ts. */
export const recipeHost = z
  .enum(['claude-code', 'codex', 'both'])
  .describe('Install target host (claude-code | codex | both)');

/** Memory separation mode — mirrors MemorySeparateMode in src/core/provision/memory-separate.ts. */
export const recipeMemoryMode = z
  .enum(['gitignore', 'submodule'])
  .describe('Memory separation mode (gitignore | submodule)');

// Recipe agent role = autopilot owner role 정본(nodeOwner) MINUS pseudo-owners.
// driver/main-session are not spawnable subagents, so they cannot be a variant
// role — same exclusion as ROLE_OPTIONS in src/cli/wizard/agent-link-step.ts.
// Derived from nodeOwner.options so it never drifts from the canonical enum.
const PSEUDO_OWNERS = new Set(['driver', 'main-session']);
const RECIPE_ROLE_VALUES = nodeOwner.options.filter((role) => !PSEUDO_OWNERS.has(role));

/** Linkable agent role — nodeOwner minus driver/main-session. */
export const recipeAgentRole = z
  .enum(RECIPE_ROLE_VALUES as [string, ...string[]])
  .describe('Agent role link target (autopilot owner role minus driver/main-session)');

/** One agent→role link, applied by the provision/agent-link step headlessly. */
export const recipeAgentLink = z.object({
  name: z.string().min(1),
  role: recipeAgentRole,
});

export const recipe = z
  .object({
    host: recipeHost.optional(),
    // Provision step consumes tool ids (ProvisionCandidate.id — e.g. 'codeql',
    // 'playwright', an LSP language id). A minimal id list is all it needs.
    tools: z.array(z.string()).optional(),
    agents: z.array(recipeAgentLink).optional(),
    memory: recipeMemoryMode.optional(),
  })
  .describe('Headless ditto setup recipe (recipe.yaml)');

export type Recipe = z.infer<typeof recipe>;
export type RecipeAgentLink = z.infer<typeof recipeAgentLink>;
