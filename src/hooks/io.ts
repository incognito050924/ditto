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

/** Process entry: read stdin, run the handler through the fail-open wrapper, emit, exit. */
export async function executeHook(handler: HookHandler): Promise<never> {
  const input: HookInput = {
    raw: await readStdinJson(),
    repoRoot: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    env: process.env,
  };
  const out = await runHook(handler, input);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.exitCode);
}
