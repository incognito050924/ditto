import { z } from 'zod';
import { nodeOwner } from './autopilot';
import { dittoConfigGithub } from './ditto-config';
import { envRef } from './journey-dsl';

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
 * E2E CI-evidence source — WHERE a protected-branch push reads its E2E pass/fail
 * from (wi_2607095fz). PORTABLE by construction: `source` is an ENUM, so an
 * unsupported provider (e.g. `gitlab-ci`) FAILS validation rather than flowing
 * through as dead config the gate cannot honor. `.strict()` so a typo'd/unknown
 * field (e.g. a literal-token slot) fails loud instead of being silently dropped.
 *
 * CREDENTIAL-FREE: `token` is an `envRef` (env:VAR | secret:VAR) — never a literal
 * secret in the recipe. `repo` is `owner/name`; when ABSENT it is derived from the
 * git remote at RUNTIME (the schema carries no default here — the engine resolves
 * it, so a recipe copied between repos does not pin the wrong coordinate).
 */
export const recipeE2eEvidence = z
  .object({
    source: z.enum(['github-checks']).default('github-checks'),
    repo: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, 'repo must be owner/name')
      .optional(),
    check_name_template: z.string().min(1).default('e2e/{journey}'),
    token: envRef.optional(),
  })
  .strict()
  .describe('E2E CI-evidence source (portable enum + credential-free envRef token)');

/**
 * E2E push gate — declares which branches require a passing E2E CI run (read from
 * a portable evidence source) before a push is allowed (wi_2607095fz). DISTINCT
 * from `push_gate` (which runs a local test_command): this gate reads CI evidence.
 * Like every recipe block it is OVERRIDE-ONLY — an absent `e2e_gate` means the gate
 * is inactive. When present it is FULLY specified: at least one protected branch
 * (`.min(1)`) AND a required `evidence` block, so a half-declared gate fails
 * validation rather than silently doing nothing. Declarable at BOTH the top level
 * (ROOT repo) and inside each `repos[]` entry — PER-REPO symmetric with `push_gate`.
 */
export const recipeE2eGate = z
  .object({
    protected_branches: z.array(z.string().min(1)).min(1),
    evidence: recipeE2eEvidence,
  })
  .describe('E2E CI-evidence push gate (protected branches + portable evidence source)');

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
    e2e_gate: recipeE2eGate.optional(),
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
    // Explicit barrier OPT-OUT. When true, an absent/no-command barrier is treated as
    // NOT-APPLICABLE (excluded from the completion verdict) instead of flooring
    // final_verdict to unverified — for a project that INTENTIONALLY relies on
    // push_gate/CI rather than an in-loop barrier (e.g. a uniform in-process suite
    // where a barrier subset would just duplicate the push gate). Distinguishes
    // "deliberately no barrier" (this flag) from "forgot to declare one" (absent →
    // still floors, the safe default). Only affects the no-command DEGRADE path — a
    // barrier that RUNS and FAILS still fails.
    barrier_opt_out: z.boolean().optional(),
    // E2E CI-evidence push gate for the ROOT repo. Per-repo symmetric field lives
    // in repos[]. Distinct from push_gate (local test_command) — see recipeE2eGate.
    e2e_gate: recipeE2eGate.optional(),
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
export type RecipeE2eEvidence = z.infer<typeof recipeE2eEvidence>;
export type RecipeE2eGate = z.infer<typeof recipeE2eGate>;
