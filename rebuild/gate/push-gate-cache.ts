import { localDir } from '../util/paths';

/**
 * Push-gate green-tree cache — lets the pre-push gate SKIP a redundant full-suite
 * re-run when the EXACT tree being pushed already passed the gate's `test_command`.
 * Safety is preserved by construction: a skip needs a CLEAN working tree AND an
 * exact git-tree-hash match, and a green record is only written when the run command
 * equals the gate command (a subset run can never authorize a full-gate skip).
 * Everything else falls back to running the full command.
 *
 * The cache is content-addressed by git tree hash, so it is safe to share across
 * worktrees (a green tree is green regardless of which branch produced it). It lives
 * under the gitignored `.ditto/local/` (tier ③), so it is per-machine and never
 * committed.
 */

export interface TreeState {
  /** `git rev-parse HEAD^{tree}` — the content hash of HEAD's tree. */
  tree: string;
  /** True when `git status --porcelain` is empty (working tree == HEAD tree). */
  clean: boolean;
}

export interface GreenTree {
  tree: string;
  recorded_at: string;
  /** The exact command whose pass recorded this tree (audit; == gate command). */
  command: string;
}

export interface GreenCache {
  trees: GreenTree[];
}

/** Keep the cache bounded; oldest entries are dropped first (FIFO). */
export const MAX_GREEN_TREES = 20;

export const EMPTY_CACHE: GreenCache = { trees: [] };

/**
 * Untracked runtime-trail prefixes the clean check FORGIVES: ditto writes these as a
 * side effect of merely running (a Run's work-item events, memory events), so an
 * otherwise-committed tree that is dirty ONLY with fresh untracked trails is still
 * "clean enough" to hit the green-tree cache — the cache key is HEAD's tree, which
 * untracked files never change. The trailing slash is load-bearing: a sibling like
 * `.ditto/work-items-x/` must NOT match.
 */
const IGNORABLE_TRAIL_PREFIXES = ['.ditto/work-items/', '.ditto/memory/'] as const;

/**
 * Decide clean/dirty from RAW `git status --porcelain` output for the green-tree
 * cache. A porcelain line is `XY <path>` (X=staged col, Y=worktree col; `??`=
 * untracked). The tree is CLEAN iff EVERY line is an UNTRACKED (`??`) file under one
 * of {@link IGNORABLE_TRAIL_PREFIXES}. ANY tracked/staged change (even under a trail
 * prefix), or any untracked file outside a trail, is DIRTY — the gate is never
 * weakened, only fresh untracked trails are forgiven. Empty output → clean.
 *
 * Feed the UNTRIMMED porcelain: a global trim would strip the first line's leading
 * status-column space, confusing ` M path` (tracked-modified) with `?? path`.
 */
export function isTreeCleanIgnoringTrails(porcelain: string): boolean {
  const lines = porcelain.split('\n').filter((l) => l.length > 0);
  return lines.every((line) => {
    const status = line.slice(0, 2);
    const path = line.slice(3);
    return status === '??' && IGNORABLE_TRAIL_PREFIXES.some((pre) => path.startsWith(pre));
  });
}

/**
 * Skip the gate ONLY when the working tree is clean AND HEAD's tree hash is a
 * recorded green. A dirty tree (tested content ≠ HEAD tree) or an unknown hash
 * always runs the full command.
 */
export function shouldSkipGate(state: TreeState, cache: GreenCache): boolean {
  if (!state.clean) return false;
  return cache.trees.some((t) => t.tree === state.tree);
}

/**
 * Record a green tree ONLY when the run command is byte-identical to the gate's
 * `test_command` AND the tree was clean. A different command (e.g. a scoped subset)
 * proves nothing about the full gate, so it must never seed a skip.
 */
export function shouldRecordGreen(commandRun: string, gateCommand: string, clean: boolean): boolean {
  return clean && commandRun === gateCommand;
}

/** Append a green tree (dedupe → newest wins), FIFO-capped at {@link MAX_GREEN_TREES}. */
export function addGreenTree(
  cache: GreenCache,
  tree: string,
  command: string,
  recordedAt: string,
): GreenCache {
  const kept = cache.trees.filter((t) => t.tree !== tree);
  kept.push({ tree, recorded_at: recordedAt, command });
  return { trees: kept.slice(-MAX_GREEN_TREES) };
}

/** The gitignored, per-machine cache file for a repo rooted at `repoRoot` (tier ③). */
export function greenCachePath(repoRoot: string): string {
  return localDir(repoRoot, 'push-gate-green.json');
}
