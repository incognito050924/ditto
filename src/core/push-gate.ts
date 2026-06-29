import type { Recipe, RecipePushGate } from '~/schemas/recipe';

/**
 * Push-gate core (wi_260629i9c) — PURE, no I/O. The CLI/hook layer reads git
 * pre-push stdin and the resolved recipe, then calls these to decide whether the
 * configured test command must pass before the push proceeds.
 */

const ZERO_SHA = /^0{40}$/;

/**
 * Parse git pre-push stdin into the remote BRANCH names being pushed. Git feeds
 * the hook one line per ref: `<local ref> <local sha> <remote ref> <remote sha>`.
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
