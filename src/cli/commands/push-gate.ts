import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, parse, relative, resolve } from 'node:path';
import { defineCommand } from 'citty';
import { isAtOrAboveHome, resolveRepoRootForCreate } from '~/core/fs';
import {
  isRepoDeclared,
  parsePushedBranches,
  pushGateDecision,
  resolvePushGate,
} from '~/core/push-gate';
import {
  type GreenCache,
  type TreeState,
  addGreenTree,
  greenCachePath,
  shouldRecordGreen,
  shouldSkipGate,
} from '~/core/push-gate-cache';
import { loadResolvedRecipe } from '~/core/recipe/load';
import { type TestRunOutcome, type TestRunner, runTestCommand } from '~/core/test-runner';
import { KILL_SWITCH } from '~/hooks/runtime';
import type { RecipePushGate } from '~/schemas/recipe';

/**
 * `ditto push-gate` (wi_260629i9c) — the recipe-driven git pre-push gate. The
 * pre-push hook feeds git's `<localref> <localsha> <remoteref> <remotesha>` lines
 * on stdin; this command resolves the workspace `recipe.yaml`'s `push_gate` for the
 * repo being pushed and, when a PROTECTED branch is in the push, runs the gate's
 * `test_command` — blocking the push (non-zero exit) if it fails. Non-protected
 * pushes and an absent gate exit 0 (allow). When the gate CANNOT be evaluated on a
 * push — a malformed recipe, or a test runner that won't spawn — it FAILS CLOSED
 * (blocks) with actionable guidance, never silently allowing. `DITTO_SKIP_HOOKS`
 * is the sanctioned bypass (mirrors the hook kill-switch).
 */

/**
 * Outcome of attempting to run the gate's test command — the shared four-terminal
 * classification (passed/failed/unrunnable/timeout) from `~/core/test-runner`, so
 * push-gate and the settled-tree barrier discriminate exit codes through ONE source.
 */
export type PushTestOutcome = TestRunOutcome;

/** Run the gate's test command in `cwd` and report the outcome. Injectable for tests. */
export type RunTest = TestRunner;

export interface ExecPushGateInput {
  /** Raw git pre-push stdin (`<localref> <localsha> <remoteref> <remotesha>` lines). */
  stdin: string;
  /** Resolved push_gate for THIS repo (undefined → no gate here). */
  gate: RecipePushGate | undefined;
  /** A recipe FILE existed but failed to parse/validate (fail-closed signal). */
  malformedRecipe: boolean;
  env: Record<string, string | undefined>;
  cwd: string;
  runTest: RunTest;
  /**
   * Green-tree cache wiring (wi_260706d0i). All optional → absent means "no cache"
   * (never skip, never record — the pre-cache behavior, so existing callers are
   * unchanged). When provided: skip the re-run iff `treeState` is clean and its hash
   * is in `greenCache`; on a gate pass, `recordGreen` records the tree so the next
   * push of the identical clean tree skips.
   */
  treeState?: TreeState;
  greenCache?: GreenCache;
  recordGreen?: (tree: string, command: string) => void;
}

export interface ExecPushGateResult {
  exitCode: number;
  /** Human guidance written to stderr by the caller (set only when blocking). */
  message?: string;
}

/** The escape hatches a blocked push has, named in every fail-closed message. */
const GUIDANCE = 'Push a non-protected branch, or set DITTO_SKIP_HOOKS=1 to bypass.';

/**
 * Decide the pre-push gate's exit code. PURE except for the injected `runTest`
 * (the gate's only side effect — spawning the test command).
 *
 * Precedence:
 *  1. `DITTO_SKIP_HOOKS` set → allow (exit 0), even over a malformed recipe or a
 *     failing test — it is the sanctioned escape hatch.
 *  2. Malformed recipe → BLOCK. A recipe file existed but is unparseable, so we
 *     cannot tell which branches are protected; failing closed beats silently
 *     allowing a push that should have been gated.
 *  3. No protected branch in the push (non-protected, or absent gate) → allow.
 *  4. Protected push → run the gate's test command: passed → allow; failed →
 *     block; unrunnable (runner absent) → BLOCK with guidance; timeout (hang past
 *     the wall clock) → BLOCK. Every non-pass terminal fails closed.
 */
export async function execPushGate(inp: ExecPushGateInput): Promise<ExecPushGateResult> {
  if (inp.env[KILL_SWITCH]) return { exitCode: 0 };
  if (inp.malformedRecipe) {
    return {
      exitCode: 1,
      message: `push-gate: recipe.yaml is malformed — cannot evaluate the push gate, blocking. ${GUIDANCE}`,
    };
  }
  const decision = pushGateDecision(parsePushedBranches(inp.stdin), inp.gate);
  if (!decision.run) return { exitCode: 0 };

  // Green-tree cache (wi_260706d0i): a CLEAN tree whose exact hash already passed
  // this gate's command needs no re-run. A dirty tree or an unknown hash falls
  // through to the full run — the skip can never be reached without an exact match.
  if (inp.treeState && inp.greenCache && shouldSkipGate(inp.treeState, inp.greenCache)) {
    return {
      exitCode: 0,
      message: `push-gate: green-tree cache hit (${inp.treeState.tree.slice(0, 12)}) — \`${decision.test_command}\` already passed on this exact clean tree, skipping re-run.`,
    };
  }

  const outcome = await inp.runTest(decision.test_command, inp.cwd);
  switch (outcome.kind) {
    case 'passed':
      // Record this tree as green so a later push of the identical clean tree skips.
      // The command IS the gate command here (shouldRecordGreen guards clean).
      if (
        inp.treeState &&
        inp.recordGreen &&
        shouldRecordGreen(decision.test_command, decision.test_command, inp.treeState.clean)
      ) {
        inp.recordGreen(inp.treeState.tree, decision.test_command);
      }
      return { exitCode: 0 };
    case 'failed':
      return {
        exitCode: 1,
        message: `push-gate: \`${decision.test_command}\` failed — push blocked. Fix the tests, or set DITTO_SKIP_HOOKS=1 to bypass.`,
      };
    case 'unrunnable':
      return {
        exitCode: 1,
        message: `push-gate: cannot run \`${decision.test_command}\` (${outcome.reason}) — blocking. ${GUIDANCE}`,
      };
    case 'timeout':
      // A hang (deadlock / waiting on stdin) trips the wall clock. push-gate FAILS CLOSED
      // — it BLOCKS (the OPPOSITE of the barrier's degrade-proceed): an unverifiable gate
      // must never silently allow a push.
      return {
        exitCode: 1,
        message: `push-gate: \`${decision.test_command}\` timed out after ${outcome.timeoutMs}ms — blocking. ${GUIDANCE}`,
      };
  }
}

/**
 * Generous wall-clock ceiling for the push gate. push-gate runs the FULL project suite
 * (~200s for the real suite), so only a genuine HANG (deadlock / waiting on stdin) may
 * trip this — never a slow-but-progressing run. This is push-gate's OWN value, distinct
 * from the barrier's default (the barrier runs a unit subset): a short shared default
 * must never be reused here.
 */
export const PUSH_GATE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Production test runner: the shared `runTestCommand` (single tested spawn + exit-code
 * classifier in `~/core/test-runner`) bound to push-gate's generous timeout. Kept as the
 * injectable seam's DEFAULT so tests still override `runTest`. The `sh -c` invocation,
 * inherited streams, and 0/126/127/other classification are all now sourced from that one
 * helper; push-gate merely adds the wall-clock ceiling and the fail-closed disposition.
 */
const defaultRunTest: RunTest = (testCommand, cwd) =>
  runTestCommand(testCommand, cwd, { timeoutMs: PUSH_GATE_TIMEOUT_MS });

/** The trusted recipe location for a push, plus this repo's dir relative to it. */
export interface PushGateRoot {
  /** Directory whose `recipe.yaml` governs the gate (the trusted workspace root). */
  recipeRoot: string;
  /** `cwd` relative to `recipeRoot` — `''` for the root repo, else a `repos[]` dir. */
  repoRelDir: string;
}

/**
 * Resolve the TRUSTED recipe root for a push and `cwd`'s dir within it (wi_2606299kn
 * ac-3, ROOT-ONLY trust). `ditto workspace sync` clones declared sub-repos into a
 * workspace; a cloned sub-repo may ship its OWN `.ditto/recipe.yaml`. A naive walk-up
 * (`resolveRepoRootForCreate`/`findRepoRoot`) STOPS at the first `.ditto` ancestor, so
 * a `git push` from inside the clone would resolve and run the CLONE's own
 * `push_gate.test_command` — push-time RCE. This resolver instead anchors on the
 * trusted WORKSPACE-ROOT recipe and never consults a cloned sub-repo's own recipe.
 *
 * Precedence:
 *  1. An explicit `explicitRoot` — the seam N5 wires into the installed sub-repo hook
 *     (`--workspace-root <abs>`, baked at setup time from the trusted root). Used
 *     verbatim: the strongest anchor.
 *  2. Else WALK UP from `cwd`'s parent: the nearest ANCESTOR whose recipe DECLARES this
 *     dir in `repos[]` is the trusted workspace root. Only a workspace-root recipe can
 *     declare a sub-repo, and a cloned sub-repo cannot forge an ancestor on the victim's
 *     disk — so this re-roots ONLY for genuinely-declared members (defense in depth, no
 *     dependency on N5 wiring). Capped at `$HOME` like `findRepoRoot`.
 *  3. Else the single-repo case — `resolveRepoRootForCreate(cwd)`, unchanged: a normal
 *     standalone repo (no ancestor declares it) resolves its OWN recipe (no regression).
 */
export async function resolvePushGateRoot(
  cwd: string,
  explicitRoot?: string,
  homeDir: string = homedir(),
): Promise<PushGateRoot> {
  const start = resolve(cwd);
  if (explicitRoot !== undefined && explicitRoot !== '') {
    const recipeRoot = resolve(explicitRoot);
    return { recipeRoot, repoRelDir: relative(recipeRoot, start) };
  }
  const home = resolve(homeDir);
  const fsRoot = parse(start).root;
  let current = dirname(start);
  while (true) {
    if (isAtOrAboveHome(relative(current, home))) break;
    const recipe = await loadResolvedRecipe(current, undefined);
    if (isRepoDeclared(recipe, relative(current, start))) {
      return { recipeRoot: current, repoRelDir: relative(current, start) };
    }
    if (current === fsRoot) break;
    current = dirname(current);
  }
  const recipeRoot = await resolveRepoRootForCreate(start, homeDir);
  return { recipeRoot, repoRelDir: relative(recipeRoot, start) };
}

/** Run a git subcommand in `cwd`, returning trimmed stdout or null on any failure. */
function gitOut(gitArgs: string[], cwd: string): string | null {
  try {
    const p = Bun.spawnSync(['git', ...gitArgs], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    });
    if (p.exitCode !== 0) return null;
    return (p.stdout?.toString() ?? '').trim();
  } catch {
    return null;
  }
}

/**
 * Compute the tree identity of the push (HEAD's tree hash) + whether the working
 * tree is clean. Returns undefined when there is no HEAD (unborn branch) or git is
 * unavailable — the caller then never skips (fail-safe: run the full gate).
 */
function computeTreeState(cwd: string): TreeState | undefined {
  const tree = gitOut(['rev-parse', 'HEAD^{tree}'], cwd);
  if (!tree) return undefined;
  const status = gitOut(['status', '--porcelain'], cwd);
  return { tree, clean: status === '' };
}

/** Read the green-tree cache; an absent/corrupt file reads as empty (never a false skip). */
function readGreenCache(cwd: string): GreenCache {
  try {
    const parsed = JSON.parse(readFileSync(greenCachePath(cwd), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as GreenCache).trees)) {
      return parsed as GreenCache;
    }
  } catch {
    // absent or corrupt → treat as empty
  }
  return { trees: [] };
}

/** A recorder that read-modify-writes the cache file; any failure is swallowed (never blocks a push). */
function makeRecordGreen(cwd: string, cache: GreenCache): (tree: string, command: string) => void {
  return (tree, command) => {
    try {
      const next = addGreenTree(cache, tree, command, new Date().toISOString());
      const path = greenCachePath(cwd);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    } catch {
      // a cache write failure must never block a legitimate push
    }
  };
}

/**
 * Cross-tool producer (wi_260706d0i): when ANOTHER command (e.g. `ditto verify -- bun test`)
 * runs the push gate's EXACT `test_command` and passes on a clean tree, prime the
 * green-tree cache so the following push of that tree skips the redundant re-run.
 * The exact-command match is the poison barrier — a scoped subset command proves
 * nothing about the full gate and never records. Best-effort: any error is swallowed,
 * so a cache failure never affects the caller's own outcome.
 */
export async function maybeRecordGreenForGate(
  cwd: string,
  commandRun: string,
  exitCode: number,
): Promise<void> {
  try {
    if (exitCode !== 0) return;
    const { recipeRoot, repoRelDir } = await resolvePushGateRoot(cwd);
    const recipe = await loadResolvedRecipe(recipeRoot, undefined, () => {});
    const gate = resolvePushGate(recipe, repoRelDir);
    if (!gate) return;
    const treeState = computeTreeState(cwd);
    if (!treeState) return;
    if (!shouldRecordGreen(commandRun, gate.test_command, treeState.clean)) return;
    makeRecordGreen(recipeRoot, readGreenCache(recipeRoot))(treeState.tree, gate.test_command);
  } catch {
    // never let a cache write disturb the caller
  }
}

/** Read all of stdin to a string (git pre-push feeds the ref lines here). */
async function readStdin(): Promise<string> {
  try {
    return await Bun.stdin.text();
  } catch {
    return '';
  }
}

export const pushGateCommand = defineCommand({
  meta: {
    name: 'push-gate',
    description:
      'Pre-push gate: read git pre-push stdin, resolve the recipe push_gate for this repo, and run its test_command before allowing a push to a protected branch. Blocks (non-zero) on a failing/unrunnable gate or a malformed recipe; exits 0 otherwise. Bypass with DITTO_SKIP_HOOKS=1.',
  },
  args: {
    'workspace-root': {
      type: 'string',
      description:
        'Absolute path to the TRUSTED workspace root whose recipe.yaml governs this push. The installed sub-repo pre-push hook passes this (wired by setup/workspace sync) so a cloned sub-repo NEVER resolves its own recipe (ROOT-ONLY trust). Omit for a normal single-repo push.',
    },
  },
  run: async ({ args }) => {
    const stdin = await readStdin();
    const cwd = process.cwd();
    // ROOT-ONLY trust: resolve the recipe at the TRUSTED workspace root — an explicit
    // `--workspace-root` (the sub-repo hook's wired pointer) wins, else a `repos[]`
    // declaration walk-up, else this repo's own root. A cloned sub-repo's own recipe
    // is never consulted; the gate is keyed by this repo's dir relative to that root.
    const { recipeRoot, repoRelDir } = await resolvePushGateRoot(cwd, args['workspace-root']);
    let malformedRecipe = false;
    const recipe = await loadResolvedRecipe(recipeRoot, undefined, () => {
      malformedRecipe = true;
    });
    const gate = resolvePushGate(recipe, repoRelDir);
    // Green-tree cache is keyed off THIS repo's git tree (cwd), stored under the
    // trusted recipe root's `.ditto/local/` so worktrees of one workspace share it.
    const treeState = computeTreeState(cwd);
    const greenCache = readGreenCache(recipeRoot);
    const result = await execPushGate({
      stdin,
      gate,
      malformedRecipe,
      env: process.env,
      cwd,
      runTest: defaultRunTest,
      ...(treeState ? { treeState } : {}),
      greenCache,
      recordGreen: makeRecordGreen(recipeRoot, greenCache),
    });
    if (result.message) process.stderr.write(`${result.message}\n`);
    process.exit(result.exitCode);
  },
});
