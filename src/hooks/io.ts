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
 * Host-aware repo root. Claude Code exports `$CLAUDE_PROJECT_DIR`; Codex does
 * not, so it falls back to the event's `cwd`. Both end at `process.cwd()`.
 */
function resolveRepoRoot(host: 'claude-code' | 'codex', raw: unknown): string {
  const cwd =
    typeof (raw as { cwd?: unknown })?.cwd === 'string' ? (raw as { cwd: string }).cwd : undefined;
  if (host === 'codex') return cwd ?? process.cwd();
  return process.env.CLAUDE_PROJECT_DIR ?? cwd ?? process.cwd();
}

/** Process entry: read stdin, run the handler through the fail-open wrapper, emit, exit. */
export async function executeHook(
  handler: HookHandler,
  host: 'claude-code' | 'codex' = 'claude-code',
): Promise<never> {
  const raw = await readStdinJson();
  const input: HookInput = {
    raw,
    repoRoot: resolveRepoRoot(host, raw),
    env: process.env,
    host,
  };
  const out = await runHook(handler, input);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.exitCode);
}
