// Codex host surface: hook envelope (N5, wi_260613f9d).
//
// The Claude-side homolog (tests/host/claude/hooks-envelope.surface.test.ts)
// exercises `ditto hook <event>` with CLAUDE_PROJECT_DIR + Claude stdin. This
// file exercises the SAME entry with `--host codex` + Codex stdin field names
// (prompt / tool_name / tool_input / tool_response / trigger / session_id / cwd),
// asserting the dispatch + envelope for all 5 events. N4 implemented the
// `--host codex` branch (repoRoot from cwd, apply_patch normalization); this
// verifies the host surface. Thin on gate logic (the unit tests cover that);
// apply_patch gate/evidence integration is N6, not here.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..');
const CLI = join(REPO, 'src', 'cli', 'index.ts');

const EVENTS = ['user-prompt-submit', 'pre-tool-use', 'post-tool-use', 'pre-compact', 'stop'];

let projectDir: string;
beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ditto-host-codex-hook-'));
});
afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

/**
 * Run `ditto hook <event> --host codex` the way a Codex plugin hook would: the
 * event JSON on stdin (with Codex `cwd` for the repo root), and CRUCIALLY no
 * CLAUDE_PROJECT_DIR — Codex never sets it, so this asserts the cwd fallback.
 * The env is stripped of CLAUDE_PROJECT_DIR / DITTO_SKIP_HOOKS so neither the
 * host's own env nor the kill-switch can pollute the result.
 */
function runCodexHook(event: string, payload: Record<string, unknown>) {
  const env = { ...process.env };
  env.CLAUDE_PROJECT_DIR = undefined as unknown as string;
  env.CLAUDE_PROJECT_DIR = undefined;
  env.DITTO_SKIP_HOOKS = undefined;
  return Bun.spawnSync(['bun', 'run', CLI, 'hook', event, '--host', 'codex'], {
    stdin: Buffer.from(JSON.stringify({ cwd: projectDir, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
}

describe('Codex host surface — hook envelope', () => {
  test.each(EVENTS)('benign %s event exits 0 (fail-open envelope)', (event) => {
    const proc = runCodexHook(event, { session_id: 'codex-s1', prompt: 'hello' });
    expect(proc.exitCode).toBe(0);
  });

  test('UserPromptSubmit injects DITTO charter context via the Codex envelope', () => {
    const proc = runCodexHook('user-prompt-submit', {
      session_id: 'codex-ups',
      prompt: 'build X',
    });
    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString());
    // Codex stdout shape is identical to Claude (F3): hookSpecificOutput.additionalContext.
    expect(out.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput?.additionalContext ?? '').toContain('prime directive');
  });

  test('repoRoot falls back to Codex cwd (no CLAUDE_PROJECT_DIR set)', () => {
    // The handler logs the classification under the resolved repoRoot. With no
    // CLAUDE_PROJECT_DIR, the only way exit 0 + context injection works is the
    // cwd fallback (N4 resolveRepoRoot). The charter context proves the handler ran.
    const proc = runCodexHook('user-prompt-submit', {
      session_id: 'codex-cwd',
      prompt: 'do thing',
    });
    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString());
    expect(out.hookSpecificOutput?.additionalContext ?? '').toContain('prime directive');
  });

  test('PreToolUse allows a benign Read tool (exit 0)', () => {
    const proc = runCodexHook('pre-tool-use', {
      tool_name: 'Read',
      tool_input: { file_path: join(projectDir, 'src', 'a.ts') },
    });
    expect(proc.exitCode).toBe(0);
  });

  test('PreToolUse blocks a secret-file write (exit 2) through the Codex envelope', () => {
    const proc = runCodexHook('pre-tool-use', {
      tool_name: 'Write',
      tool_input: { file_path: join(projectDir, '.env') },
    });
    expect(proc.exitCode).toBe(2);
  });

  test('PreToolUse blocks a destructive Bash command (exit 2)', () => {
    const proc = runCodexHook('pre-tool-use', {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });
    expect(proc.exitCode).toBe(2);
  });

  test('PostToolUse on a tool run exits 0 (observational, never blocks)', () => {
    const proc = runCodexHook('post-tool-use', {
      session_id: 'codex-post',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { exit_code: 0 },
    });
    expect(proc.exitCode).toBe(0);
  });

  test('PreCompact with a manual trigger exits 0', () => {
    const procManual = runCodexHook('pre-compact', { session_id: 'codex-pc', trigger: 'manual' });
    expect(procManual.exitCode).toBe(0);
    const procAuto = runCodexHook('pre-compact', { session_id: 'codex-pc', trigger: 'auto' });
    expect(procAuto.exitCode).toBe(0);
  });

  test('Stop with stop_hook_active short-circuits (exit 0)', () => {
    const proc = runCodexHook('stop', { session_id: 'codex-stop', stop_hook_active: true });
    expect(proc.exitCode).toBe(0);
  });

  test('Stop with no active work item exits 0 (nothing to judge)', () => {
    // No session pointer → no work item → the completion/convergence gates have
    // nothing to check, so the Codex Stop envelope yields cleanly.
    const proc = runCodexHook('stop', { session_id: 'codex-stop-empty' });
    expect(proc.exitCode).toBe(0);
  });

  test('malformed stdin fails OPEN (exit 0)', () => {
    const env = { ...process.env };
    env.CLAUDE_PROJECT_DIR = undefined;
    env.DITTO_SKIP_HOOKS = undefined;
    const proc = Bun.spawnSync(['bun', 'run', CLI, 'hook', 'pre-tool-use', '--host', 'codex'], {
      stdin: Buffer.from('{not valid json'),
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    });
    expect(proc.exitCode).toBe(0);
  });
});
