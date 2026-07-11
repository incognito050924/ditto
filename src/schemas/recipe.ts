import { z } from 'zod';
import { nodeOwner } from './autopilot';
import { dittoConfigGithub } from './ditto-config';

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

/**
 * Push gate — declares which branches require a passing test run before a push
 * is allowed (wi_260629i9c). Consumed at push time by the git pre-push gate, not
 * by `ditto setup`. Like every recipe block it carries ONLY explicit config: an
 * absent `push_gate` means the gate is inactive (no default-on). When present it
 * is fully specified — at least one protected branch and a non-empty command — so
 * a half-declared gate fails validation rather than silently doing nothing.
 */
export const recipePushGate = z
  .object({
    protected_branches: z.array(z.string().min(1)).min(1),
    test_command: z.string().min(1),
  })
  .describe('Push gate: branches whose push requires test_command to pass');

/**
 * Barrier test command — the side-effect-free UNIT SUBSET a tester barrier runs
 * during autopilot (wi_260708ds9). DISTINCT from `push_gate.test_command`: that is
 * the push-time FULL-suite guard; this is the fast in-loop barrier oracle.
 *
 * CAVEAT (the ONLY thing holding the safe-by-construction premise): this MUST be a
 * side-effect-free unit subset — do NOT point it at infra-touching / integration
 * tests (no live DB, no network, no shared fixtures). A barrier that hits real
 * infra can corrupt shared state under parallel node execution.
 *
 * FAIL-SAFE ESCAPE: if you cannot express a side-effect-free unit subset for your
 * stack, LEAVE THIS ABSENT — the barrier then DEGRADES to tests-unverified (honest)
 * rather than running an unsafe suite. NEVER copy `push_gate.test_command` here:
 * that is the push-time FULL suite and would re-introduce the shared-infra hazard
 * on EVERY completion (the barrier fires far more often than a push).
 *
 * Like every recipe field it is OVERRIDE-ONLY (recipe.ts:8-13): ABSENT drives a
 * runtime DEGRADE (the barrier has no command to run — not a validation failure).
 * Present-but-empty fails `min(1)`. It is declarable at BOTH the top level (ROOT
 * repo) and inside each `repos[]` entry — PER-REPO symmetric with `push_gate`, so a
 * multi-repo workspace's sub-repos resolve their own barrier command.
 */
export const recipeBarrierTestCommand = z
  .string()
  .min(1)
  .describe('Side-effect-free unit-subset barrier command (distinct from push_gate.test_command)');

/**
 * Per-file runner SOURCE for the pre-approval phantom-red gate (wi_2607103tp ac-1). The
 * phantom-red gate runs each authored red test through `<this> "<test_path>"`; when absent
 * it falls back to `barrier_test_command`. Kept DISTINCT from `barrier_test_command`
 * precisely so a project that opts OUT of the settled-tree barrier (or never arms one) can
 * still feed phantom-red discrimination without ARMING the barrier — the barrier resolves
 * from `barrier_test_command` alone, so this field never turns a no-barrier project into one.
 */
export const recipeAuthoredTestCommand = z
  .string()
  .min(1)
  .describe('Phantom-red per-file authored-red runner source; falls back to barrier_test_command');

/**
 * One nested repo (sub-repo or submodule) of a multi-repo workspace, keyed by its
 * `dir` relative to this recipe's location. Carries that repo's own config — for
 * now its `push_gate` and `barrier_test_command` (room to grow per-repo settings
 * later). The TOP-LEVEL recipe blocks describe the ROOT repo; each `repos[]` entry
 * describes one nested repo. Lets a single workspace recipe.yaml express
 * boxwood-style multi-repo gates (each sub-repo its own protected branches + test
 * command) and its own barrier command.
 */
export const recipeRepoEntry = z
  .object({
    dir: z.string().min(1),
    // git URL of the repo. Optional: when present, ditto CAN clone it into `dir`
    // (boxwood.json-style workspace assembly). The clone BEHAVIOR is a separate
    // follow-up — only the field lands now so a recipe can fully describe a repo.
    url: z.string().min(1).optional(),
    push_gate: recipePushGate.optional(),
    barrier_test_command: recipeBarrierTestCommand.optional(),
    authored_test_command: recipeAuthoredTestCommand.optional(),
  })
  .describe('A nested repo of the workspace (by dir, optional url) with its own config');

export const recipe = z
  .object({
    host: recipeHost.optional(),
    // Provision step consumes tool ids (ProvisionCandidate.id — e.g. 'codeql',
    // 'playwright', an LSP language id). A minimal id list is all it needs.
    tools: z.array(z.string()).optional(),
    agents: z.array(recipeAgentLink).optional(),
    memory: recipeMemoryMode.optional(),
    push_gate: recipePushGate.optional(),
    // Barrier unit-subset command for the ROOT repo. Per-repo symmetric field lives
    // in repos[]. See recipeBarrierTestCommand for the side-effect-free caveat.
    barrier_test_command: recipeBarrierTestCommand.optional(),
    // Phantom-red per-file authored-red runner source (wi_2607103tp ac-1). Falls back to
    // barrier_test_command; DISTINCT from it so a project can feed phantom-red without
    // arming the settled-tree barrier. See recipeAuthoredTestCommand.
    authored_test_command: recipeAuthoredTestCommand.optional(),
    // Explicit barrier OPT-OUT. When true, an absent/no-command barrier is treated as
    // NOT-APPLICABLE (excluded from the completion verdict) instead of flooring
    // final_verdict to unverified — for a project that INTENTIONALLY relies on
    // push_gate/CI rather than an in-loop barrier (e.g. a uniform in-process suite
    // where a barrier subset would just duplicate the push gate). Distinguishes
    // "deliberately no barrier" (this flag) from "forgot to declare one" (absent →
    // still floors, the safe default). Only affects the no-command DEGRADE path — a
    // barrier that RUNS and FAILS still fails.
    barrier_opt_out: z.boolean().optional(),
    // Explicit PHANTOM-RED OPT-OUT (wi_2607103tp ac-3 / M3). When true, a recorded
    // phantom-red DEGRADE (the pre-approval authored-red could not be deterministically
    // confirmed as an assertion-red — indeterminate) is treated as NOT-APPLICABLE instead
    // of flooring final_verdict off pass. DEDICATED and SEPARATE from barrier_opt_out on
    // purpose: barrier_opt_out is scoped to the settled-tree barrier's no-command degrade,
    // so reusing it here would silently suppress a genuine bun-side phantom-red degrade
    // (a real false-green risk). A project on a non-bun stack that intentionally accepts
    // indeterminate phantom-red sets THIS flag; absent → still floors (the safe default).
    phantom_red_opt_out: z.boolean().optional(),
    repos: z.array(recipeRepoEntry).optional(),
    // GitHub backlog (Project + status mapping). REUSES dittoConfigGithub (one SoT,
    // no duplicate). The shape lands now; migrating the existing per-developer github
    // config into the recipe + the ADR-20260628 reconcile is a SEPARATE follow-up.
    backlog: dittoConfigGithub.optional(),
  })
  .describe('Headless ditto setup recipe (recipe.yaml)');

export type Recipe = z.infer<typeof recipe>;
export type RecipeAgentLink = z.infer<typeof recipeAgentLink>;
export type RecipePushGate = z.infer<typeof recipePushGate>;
export type RecipeRepoEntry = z.infer<typeof recipeRepoEntry>;
export type RecipeBarrierTestCommand = z.infer<typeof recipeBarrierTestCommand>;
