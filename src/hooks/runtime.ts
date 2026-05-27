/**
 * Hook runtime glue (M1.2). Thin, deterministic wrapper around hook handlers.
 *
 * D4 two-layer fail-open:
 *  - A hook that *crashes* (unexpected exception, IO error) fails OPEN (exit 0):
 *    a broken hook must never break the user's session.
 *  - A gate that runs fine and *judges* non-compliance fails CLOSED (exit 2):
 *    that is a verdict, not a crash. Handlers produce exit 2 themselves;
 *    they do not throw. Malformed artifact (completion/convergence/autopilot)
 *    is a gate-input violation → exit 2, handled inside the handler, NOT here.
 */

export const KILL_SWITCH = 'DITTO_SKIP_HOOKS';

/** Result of a hook: stdout (UserPromptSubmit context / info), stderr (exit-2 feedback). */
export interface HookOutput {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface HookInput {
  /** Parsed stdin JSON from Claude Code (or null/`{}` when absent). */
  raw: unknown;
  /** Project dir, from `$CLAUDE_PROJECT_DIR`, falling back to cwd. */
  repoRoot: string;
  env: Record<string, string | undefined>;
}

export type HookHandler = (input: HookInput) => Promise<HookOutput> | HookOutput;

/** No-op stub for hooks registered in the manifest but not yet implemented (PreCompact/PostToolUse). */
export const noOpHandler: HookHandler = () => ({ exitCode: 0 });

export async function runHook(handler: HookHandler, input: HookInput): Promise<HookOutput> {
  // Kill-switch: a single env var disables all DITTO hooks (escape hatch).
  if (input.env[KILL_SWITCH]) return { exitCode: 0 };
  try {
    return await handler(input);
  } catch (err) {
    // Only the hook *crashing* lands here — fail open so the session survives.
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 0, stderr: `ditto hook error (fail-open): ${message}\n` };
  }
}
