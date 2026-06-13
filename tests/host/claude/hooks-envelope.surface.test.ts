// Claude Code host surface: hook envelope (N2-claude-surface-coverage, wi_260613f9d).
//
// The unit tests in tests/hooks/* call each handler in-process. This test exercises
// the HOST contract instead: `ditto hook <event>` invoked exactly as hooks.json
// wires it — CLAUDE_PROJECT_DIR for the repo root + the event JSON on stdin —
// for all 5 events. It asserts the dispatch + envelope, staying thin on logic
// (covered by the unit tests).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..');
const CLI = join(REPO, 'src', 'cli', 'index.ts');

const EVENTS = ['user-prompt-submit', 'pre-tool-use', 'post-tool-use', 'pre-compact', 'stop'];

let projectDir: string;
beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ditto-host-hook-'));
});
afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

// Run `ditto hook <event>` the way hooks.json does: stdin JSON + CLAUDE_PROJECT_DIR.
// Strip the DITTO_SKIP_HOOKS kill-switch so the test is hermetic: the gate/charter
// tests below assert the hook actually FIRES, so an ambient kill-switch (a common
// dev habit when running the suite) must not silently bypass it — mirrors the Codex
// sibling fixture (applypatch-safety.surface.test.ts).
function runHook(event: string, payload: unknown) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  env.DITTO_SKIP_HOOKS = undefined;
  return Bun.spawnSync(['bun', 'run', CLI, 'hook', event], {
    stdin: Buffer.from(JSON.stringify(payload)),
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
}

describe('Claude host surface — hook envelope', () => {
  test('hooks.json wires all 5 events to `ditto hook <event>`', () => {
    type HookGroup = { hooks: { command: string }[] };
    const wiring = require(join(REPO, 'hooks', 'hooks.json')) as {
      hooks: Record<string, HookGroup[]>;
    };
    const wiredEvents = Object.keys(wiring.hooks);
    expect(wiredEvents.sort()).toEqual(
      ['PostToolUse', 'PreCompact', 'PreToolUse', 'Stop', 'UserPromptSubmit'].sort(),
    );
    for (const handlers of Object.values(wiring.hooks)) {
      const cmd = handlers.flatMap((h) => h.hooks).map((h) => h.command);
      expect(cmd.some((c) => c.includes('hook '))).toBe(true);
    }
  });

  test.each(EVENTS)('benign %s event exits 0 (fail-open envelope)', (event) => {
    const proc = runHook(event, { session_id: 'host-s1', prompt: 'hello' });
    expect(proc.exitCode).toBe(0);
  });

  test('UserPromptSubmit injects charter context via the host envelope', () => {
    const proc = runHook('user-prompt-submit', { session_id: 'host-ups', prompt: 'build X' });
    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString());
    expect(out.hookSpecificOutput?.additionalContext ?? '').toContain('prime directive');
  });

  test('PreToolUse blocks a secret-file write (exit 2) through the envelope', () => {
    const proc = runHook('pre-tool-use', {
      tool_name: 'Write',
      tool_input: { file_path: join(projectDir, '.env') },
    });
    expect(proc.exitCode).toBe(2);
  });

  test('unknown event is rejected (exit 2)', () => {
    const proc = runHook('not-a-real-event', {});
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain('unknown event');
  });
});
