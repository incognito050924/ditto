import type { TreeState } from '~/core/push-gate-cache';

/**
 * Git-tree I/O (wi_2607095fz, finding 12) — the CORE home for reading git's tree
 * identity, extracted from the CLI-private helpers in `src/cli/commands/push-gate.ts`.
 * The push-gate green-tree cache and the e2e-gate both need HEAD's tree hash; keeping
 * these here (rather than duplicated per command) gives ONE tested source. This module
 * IS the I/O boundary — `src/core/push-gate.ts` and `src/core/e2e/e2e-gate.ts` stay
 * pure (no hidden I/O) and this is where git actually runs.
 */

/** Run a git subcommand in `cwd`, returning trimmed stdout or null on any failure. */
export function gitOut(gitArgs: string[], cwd: string): string | null {
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
export function computeTreeState(cwd: string = process.cwd()): TreeState | undefined {
  const tree = gitOut(['rev-parse', 'HEAD^{tree}'], cwd);
  if (!tree) return undefined;
  const status = gitOut(['status', '--porcelain'], cwd);
  return { tree, clean: status === '' };
}
