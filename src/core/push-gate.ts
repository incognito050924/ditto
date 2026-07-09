import type { Recipe, RecipeE2eGate, RecipePushGate } from '~/schemas/recipe';

/**
 * Push-gate core (wi_260629i9c) — PURE, no I/O. The CLI/hook layer reads git
 * pre-push stdin and the resolved recipe, then calls these to decide whether the
 * configured test command must pass before the push proceeds.
 */

const ZERO_SHA = /^0{40}$/;

/**
 * One pushed ref, as parsed from a git pre-push stdin line
 * `<local ref> <local sha> <remote ref> <remote sha>` (wi_2607095fz). Unlike
 * `parsePushedBranches` (which discards everything but the branch name), this keeps
 * the WHOLE quad — the e2e-gate needs `localSha` to read CI evidence for the EXACT
 * commit being pushed on each ref. `branch` is the `refs/heads/<name>` name, or null
 * for a tag / non-branch ref (the gate is about branch pushes).
 */
export interface PushedRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
  /** The `refs/heads/<name>` branch, or null for a tag / non-branch ref. */
  branch: string | null;
}

/**
 * Parse git pre-push stdin into the pushed refs. Git feeds the hook one line per ref:
 * `<local ref> <local sha> <remote ref> <remote sha>`.
 * - A deletion (local sha all-zero) is skipped — it pushes no commits to gate.
 * - Only `refs/heads/<branch>` remote refs yield a `branch`; tags/other refs carry
 *   `branch: null` (still surfaced, so a caller can see the tag push). A slashed
 *   branch name is kept whole.
 */
export function parsePushedRefs(stdin: string): PushedRef[] {
  const out: PushedRef[] = [];
  for (const line of stdin.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = parts as [string, string, string, string];
    if (ZERO_SHA.test(localSha)) continue; // ref deletion — nothing to gate
    const branch = remoteRef.match(/^refs\/heads\/(.+)$/)?.[1] ?? null;
    out.push({ localRef, localSha, remoteRef, remoteSha, branch });
  }
  return out;
}

/**
 * The remote BRANCH names being pushed — the legacy push-gate view, now DERIVED from
 * `parsePushedRefs` (one parser, no duplicate). Behavior is unchanged: deletions are
 * skipped and only `refs/heads/<branch>` refs contribute a name (tags dropped).
 */
export function parsePushedBranches(stdin: string): string[] {
  return parsePushedRefs(stdin)
    .map((r) => r.branch)
    .filter((b): b is string => b !== null);
}

export type PushGateDecision =
  | { run: false }
  | { run: true; test_command: string; matched: string[] };

/**
 * Decide whether the gate fires for this push. It fires when `config` is present
 * AND at least one pushed branch is listed in `protected_branches`; `matched`
 * names the protected branches actually in this push. An absent config → inactive
 * (no default-on — mirrors the recipe's explicit-override-only philosophy).
 */
export function pushGateDecision(
  pushedBranches: string[],
  config: RecipePushGate | undefined,
): PushGateDecision {
  if (!config) return { run: false };
  // A literal "*" entry is the all-branches sentinel: EVERY pushed branch is
  // protected. Otherwise it's exact-match against the listed names (additive — the
  // exact path is unchanged for non-"*" entries). Only "*" is special; partial
  // patterns like "release/*" are NOT globbed.
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
 * The ROOT-ONLY trust check (wi_2606299kn ac-3): only a workspace-root recipe that
 * declares a sub-repo is trusted to govern its push gate, so a cloned sub-repo's own
 * recipe is never consulted. The empty/`.` dir is the recipe's OWN root, not a nested
 * repo, so it is NOT a `repos[]` declaration (returns false).
 */
export function isRepoDeclared(recipe: Recipe, repoRelDir: string): boolean {
  const dir = normDir(repoRelDir);
  if (dir === '' || dir === '.') return false;
  return recipe.repos?.some((r) => normDir(r.dir) === dir) ?? false;
}

/**
 * Resolve the push_gate for ONE repo inside a workspace manifest. `repoRelDir` is
 * the repo's path relative to the recipe's location — the ROOT repo is `.` / `''`
 * (→ top-level `push_gate`); a nested repo matches a `repos[].dir` (→ that entry's
 * `push_gate`). An unknown dir, or a repo declared without a gate, yields undefined
 * (gate inactive there). Lets one recipe.yaml drive per-repo gates across a
 * boxwood-style multi-repo workspace.
 */
export function resolvePushGate(recipe: Recipe, repoRelDir: string): RecipePushGate | undefined {
  const dir = normDir(repoRelDir);
  if (dir === '' || dir === '.') return recipe.push_gate;
  return recipe.repos?.find((r) => normDir(r.dir) === dir)?.push_gate;
}

/**
 * Resolve the `e2e_gate` for ONE repo inside a workspace manifest — the CI-evidence
 * gate's mirror of `resolvePushGate` (wi_2607095fz). Same per-repo addressing: the
 * ROOT repo (`.` / `''`) → the top-level `e2e_gate`; a nested repo matches a
 * `repos[].dir` → that entry's `e2e_gate`. An unknown dir, or a repo declared without
 * an e2e gate, yields undefined (gate inactive there — THE unconfigured signal the
 * engine degrades on, never inferred from journey/evidence presence).
 */
export function resolveE2eGate(recipe: Recipe, repoRelDir: string): RecipeE2eGate | undefined {
  const dir = normDir(repoRelDir);
  if (dir === '' || dir === '.') return recipe.e2e_gate;
  return recipe.repos?.find((r) => normDir(r.dir) === dir)?.e2e_gate;
}
