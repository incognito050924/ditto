import { relative } from 'node:path';
import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import { parsePushedBranches, pushGateDecision, resolvePushGate } from '~/core/push-gate';
import { loadResolvedRecipe } from '~/core/recipe/load';
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

/** Outcome of attempting to run the gate's test command. */
export type PushTestOutcome =
  | { kind: 'passed' }
  | { kind: 'failed'; exitCode: number }
  | { kind: 'unrunnable'; reason: string };

/** Run the gate's test command in `cwd` and report the outcome. Injectable for tests. */
export type RunTest = (testCommand: string, cwd: string) => Promise<PushTestOutcome>;

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
 *     block; unrunnable (runner absent) → BLOCK with guidance.
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

  const outcome = await inp.runTest(decision.test_command, inp.cwd);
  switch (outcome.kind) {
    case 'passed':
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
  }
}

/**
 * Production test runner: spawn the command through a shell (so the recipe's
 * `test_command` may use pipes/`&&`), streaming its output to the user's terminal.
 * A POSIX `127`/`126` exit means the command itself was not found / not
 * executable — the runner is ABSENT, distinct from tests that ran and failed.
 */
const defaultRunTest: RunTest = async (testCommand, cwd) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['sh', '-c', testCommand], {
      cwd,
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    });
  } catch (err) {
    return { kind: 'unrunnable', reason: err instanceof Error ? err.message : String(err) };
  }
  const code = await proc.exited;
  if (code === 0) return { kind: 'passed' };
  if (code === 126 || code === 127) {
    return { kind: 'unrunnable', reason: `test command not found (exit ${code})` };
  }
  return { kind: 'failed', exitCode: code };
};

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
  run: async () => {
    const stdin = await readStdin();
    const cwd = process.cwd();
    // The recipe lives at the workspace ROOT (nearest `.ditto`/`.git` ancestor);
    // this repo's gate is keyed by its path relative to that recipe location.
    const recipeRoot = await resolveRepoRootForCreate(cwd);
    let malformedRecipe = false;
    const recipe = await loadResolvedRecipe(recipeRoot, undefined, () => {
      malformedRecipe = true;
    });
    const repoRelDir = relative(recipeRoot, cwd);
    const gate = resolvePushGate(recipe, repoRelDir);
    const result = await execPushGate({
      stdin,
      gate,
      malformedRecipe,
      env: process.env,
      cwd,
      runTest: defaultRunTest,
    });
    if (result.message) process.stderr.write(`${result.message}\n`);
    process.exit(result.exitCode);
  },
});
