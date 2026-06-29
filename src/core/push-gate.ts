import type { RecipePushGate } from '~/schemas/recipe';

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
  const protectedSet = new Set(config.protected_branches);
  const matched = pushedBranches.filter((b) => protectedSet.has(b));
  if (matched.length === 0) return { run: false };
  return { run: true, test_command: config.test_command, matched };
}
