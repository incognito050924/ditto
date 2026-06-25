import { resolveRepoRootForCreate } from '~/core/fs';
import { type HookHandler, type HookInput, runHook } from './runtime';

/** Read all of stdin and JSON-parse it. Returns null on empty/invalid input. */
export async function readStdinJson(): Promise<unknown> {
  try {
    const text = await Bun.stdin.text();
    if (text.trim().length === 0) return null;
    return JSON.parse(text);
  } catch {
    // Malformed stdin is an infra issue (Claude Code feeds this), not a gate
    // input — let the handler treat raw=null and the wrapper fail open.
    return null;
  }
}

/**
 * Host-aware session rooting root. Claude Code exports `$CLAUDE_PROJECT_DIR`;
 * Codex does not, so it falls back to the event's `cwd` (both end at
 * `process.cwd()`). The raw dir is then resolved UP to the workspace rooting
 * root — the nearest ancestor holding `.ditto` (else `.git`) — so the session is
 * rooted at the WORKSPACE, not at a sub-repo it happens to start in. A write to
 * a sub-repo under the rooting root is then in-scope, while a write outside it
 * stays a scope-out block: the boundary moves to the workspace, it is not removed
 * (ADR-20260626-worktree-subrepo-scope-clarify D2). Single repo: `.ditto` sits at
 * the repo root, so this returns it unchanged (no regression).
 */
export async function resolveRepoRoot(
  host: 'claude-code' | 'codex',
  raw: unknown,
): Promise<string> {
  const cwd =
    typeof (raw as { cwd?: unknown })?.cwd === 'string' ? (raw as { cwd: string }).cwd : undefined;
  const start =
    host === 'codex'
      ? (cwd ?? process.cwd())
      : (process.env.CLAUDE_PROJECT_DIR ?? cwd ?? process.cwd());
  return resolveRepoRootForCreate(start);
}

/** Process entry: read stdin, run the handler through the fail-open wrapper, emit, exit. */
export async function executeHook(
  handler: HookHandler,
  host: 'claude-code' | 'codex' = 'claude-code',
): Promise<never> {
  const raw = await readStdinJson();
  const input: HookInput = {
    raw,
    repoRoot: await resolveRepoRoot(host, raw),
    env: process.env,
    host,
  };
  const out = await runHook(handler, input);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.exitCode);
}
