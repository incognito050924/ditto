import type { GateResult } from '../schemas/gate-result';
import { type BarrierOutcome, type BarrierRun, classifyBarrierRun } from './barrier';
import { type GreenCache, type TreeState, shouldRecordGreen, shouldSkipGate } from './push-gate-cache';

/**
 * Push-gate core — PURE, no I/O. The hook/CLI layer (a later unit) reads git's
 * pre-push stdin and the resolved recipe, then calls these to decide whether the
 * configured test command must pass before the push proceeds. Push is IRREVERSIBLE,
 * so this gate is FAIL-CLOSED: any non-pass terminal (failed, unrunnable) BLOCKS —
 * the deliberate opposite of the completion barrier's degrade-to-PROCEED on the same
 * signal (ADR-20260708 D4; reversible completion vs irreversible push).
 */

const ZERO_SHA = /^0{40}$/;

/** One repo's push gate: the branches it protects and the command that must pass. */
export interface PushGateConfig {
  protected_branches: string[];
  test_command: string;
}

/** A workspace manifest: a top-level gate plus per-nested-repo gates. */
export interface PushGateRecipe {
  push_gate?: PushGateConfig;
  repos?: Array<{ dir: string; push_gate?: PushGateConfig }>;
}

/**
 * Parse git pre-push stdin into the remote BRANCH names being pushed. Git feeds the
 * hook one line per ref: `<local ref> <local sha> <remote ref> <remote sha>`.
 * - A deletion (local sha all-zero) is skipped — it pushes no commits to test.
 * - Only `refs/heads/<branch>` remote refs yield a branch; tags/other refs are
 *   ignored (the gate is about branch pushes). A slashed branch name is kept whole.
 */
export function parsePushedBranches(stdin: string): string[] {
  const out: string[] = [];
  for (const line of stdin.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const localSha = parts[1] ?? '';
    if (ZERO_SHA.test(localSha)) continue; // branch deletion — nothing to test
    const branch = (parts[2] ?? '').match(/^refs\/heads\/(.+)$/)?.[1];
    if (branch) out.push(branch);
  }
  return out;
}

export type PushGateDecision =
  | { run: false }
  | { run: true; test_command: string; matched: string[] };

/**
 * Decide whether the gate fires for this push. It fires when `config` is present AND
 * at least one pushed branch is listed in `protected_branches`; `matched` names the
 * protected branches actually in this push. An absent config → inactive (no
 * default-on — mirrors the recipe's explicit-override-only philosophy).
 *
 * A literal "*" entry is the all-branches sentinel: EVERY pushed branch is protected.
 * Otherwise it is exact-match against the listed names; partial patterns like
 * `release/*` are NOT globbed.
 */
export function pushGateDecision(
  pushedBranches: string[],
  config: PushGateConfig | undefined,
): PushGateDecision {
  if (!config) return { run: false };
  const protectedSet = new Set(config.protected_branches);
  const matched = protectedSet.has('*')
    ? [...pushedBranches]
    : pushedBranches.filter((b) => protectedSet.has(b));
  if (matched.length === 0) return { run: false };
  return { run: true, test_command: config.test_command, matched };
}

/** Normalize a workspace-relative dir: drop a leading `./` and trailing slashes. */
function normDir(d: string): string {
  return d.replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * True when `repoRelDir` names a repo this recipe DECLARES in `repos[]` — i.e. the
 * recipe's owner has explicitly adopted that nested dir as a member of its workspace.
 * ROOT-ONLY trust: only a workspace-root recipe that declares a sub-repo governs its
 * push gate, so a cloned sub-repo's own recipe is never consulted. The empty/`.` dir
 * is the recipe's OWN root, not a nested repo, so it is NOT a `repos[]` declaration.
 */
export function isRepoDeclared(recipe: PushGateRecipe, repoRelDir: string): boolean {
  const dir = normDir(repoRelDir);
  if (dir === '' || dir === '.') return false;
  return recipe.repos?.some((r) => normDir(r.dir) === dir) ?? false;
}

/**
 * Resolve the push_gate for ONE repo inside a workspace manifest. `repoRelDir` is the
 * repo's path relative to the recipe's location — the ROOT repo is `.` / `''` (→
 * top-level `push_gate`); a nested repo matches a `repos[].dir` (→ that entry's
 * `push_gate`). An unknown dir, or a repo declared without a gate, yields undefined
 * (gate inactive there).
 */
export function resolvePushGate(
  recipe: PushGateRecipe,
  repoRelDir: string,
): PushGateConfig | undefined {
  const dir = normDir(repoRelDir);
  if (dir === '' || dir === '.') return recipe.push_gate;
  return recipe.repos?.find((r) => normDir(r.dir) === dir)?.push_gate;
}

/**
 * Map a test-run outcome to the push gate's FAIL-CLOSED disposition. Reuses the
 * barrier's `passed|failed|unrunnable` discriminator (ONE source of exit-code truth,
 * ADR-20260708 follow-up "shared logic ≠ shared disposition") but routes it the
 * OPPOSITE way: only `passed` opens the gate; `failed` and `unrunnable` both BLOCK.
 * The push side must never silently allow a push it could not verify.
 */
export function pushGateDisposition(outcome: BarrierOutcome): GateResult {
  if (outcome === 'passed') {
    return { decision: 'pass', grounds: 'gate test command passed' };
  }
  return { decision: 'block', grounds: `push blocked — gate test command ${outcome}` };
}

/** Runs the gate's test command in `cwd`; returns a barrier-shaped run. Injectable. */
export type RunTest = (testCommand: string, cwd: string) => Promise<BarrierRun>;

export interface ExecPushGateInput {
  /** Raw git pre-push stdin (`<localref> <localsha> <remoteref> <remotesha>` lines). */
  stdin: string;
  /** Resolved push_gate for THIS repo (undefined → no gate here). */
  gate: PushGateConfig | undefined;
  /** A recipe FILE existed but failed to parse/validate (fail-closed signal). */
  malformedRecipe: boolean;
  /** Spawns the gate's test command. Injected so the contract is fixture-testable. */
  runTest: RunTest;
  cwd?: string;
  /**
   * Green-tree cache wiring (all optional → absent means "no cache": never skip,
   * never record). When provided: skip the re-run iff `treeState` is clean and its
   * hash is in `greenCache`; on a gate pass of the identical clean tree, `recordGreen`
   * seeds the next push's skip.
   */
  treeState?: TreeState;
  greenCache?: GreenCache;
  recordGreen?: (tree: string, command: string) => void;
}

export interface ExecPushGateResult {
  /** The fail-closed gate outcome (pass = allow push, block = stop push). */
  gate: GateResult;
  /** True when a green-tree cache hit skipped the re-run. */
  cacheHit: boolean;
}

/**
 * Compose the push gate as a callable contract (no live hook/spawn wiring here).
 * Precedence:
 *  1. Malformed recipe → BLOCK. A recipe file existed but is unparseable, so we
 *     cannot tell which branches are protected; failing closed beats silently
 *     allowing a push that should have been gated.
 *  2. No protected branch in the push (non-protected, or absent gate) → PASS.
 *  3. A clean tree whose exact hash already passed this gate → PASS (cache hit,
 *     no re-run).
 *  4. Otherwise run the gate's command and apply {@link pushGateDisposition}: passed
 *     → PASS (record green when clean); failed / unrunnable → BLOCK.
 */
export async function execPushGate(inp: ExecPushGateInput): Promise<ExecPushGateResult> {
  if (inp.malformedRecipe) {
    return {
      gate: { decision: 'block', grounds: 'recipe is malformed — cannot evaluate the push gate' },
      cacheHit: false,
    };
  }

  const decision = pushGateDecision(parsePushedBranches(inp.stdin), inp.gate);
  if (!decision.run) {
    return { gate: { decision: 'pass', grounds: 'no protected branch in this push' }, cacheHit: false };
  }

  if (inp.treeState && inp.greenCache && shouldSkipGate(inp.treeState, inp.greenCache)) {
    return {
      gate: { decision: 'pass', grounds: `green-tree cache hit (${inp.treeState.tree})` },
      cacheHit: true,
    };
  }

  const run = await inp.runTest(decision.test_command, inp.cwd ?? '.');
  const outcome = classifyBarrierRun(run);
  const gate = pushGateDisposition(outcome);

  if (
    gate.decision === 'pass' &&
    inp.treeState &&
    inp.recordGreen &&
    shouldRecordGreen(decision.test_command, decision.test_command, inp.treeState.clean)
  ) {
    inp.recordGreen(inp.treeState.tree, decision.test_command);
  }

  return { gate, cacheHit: false };
}
