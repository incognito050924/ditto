import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const cli = join(repoRoot, 'src', 'cli', 'index.ts');

function run(args: string[]) {
  // Run against the real repo root so claude-code's declared hooks match the
  // actual hooks.json registration (honest parity, no synthetic fixture).
  return Bun.spawnSync(['bun', 'run', cli, ...args], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });
}

// Build one hook event entry in the real hooks.json shape so scanPluginRoot
// registers it as kind:'hook' with id === <event>.
function hookEntry(command: string) {
  return [{ matcher: '', hooks: [{ type: 'command', command }] }];
}

describe('doctor capability', () => {
  test('ac-2: claude-code json reports 5 hook events and exits 0', () => {
    const proc = run(['doctor', 'capability', '--host', 'claude-code', '--output', 'json']);
    expect(proc.exitCode).toBe(0);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.status).toBe('ok');
    const cc = json.hosts.find((h: { host: string }) => h.host === 'claude-code');
    expect(cc.hook_events.length).toBe(5);
    expect(cc.capabilities.hooks.length).toBe(5);
  });

  test('ac-2: codex json reports 5 hook events and exits 0', () => {
    // M3 (dual-host surface adapter): codex adopted the Claude hook protocol, so
    // it declares the same 5 events and registers them from the shared
    // hooks/hooks.json — declared == registered, 0 drift, exit 0.
    const proc = run(['doctor', 'capability', '--host', 'codex', '--output', 'json']);
    expect(proc.exitCode).toBe(0);
    const json = JSON.parse(proc.stdout.toString());
    const codex = json.hosts.find((h: { host: string }) => h.host === 'codex');
    expect(codex.capabilities.hooks.length).toBe(5);
    expect([...codex.hook_events].sort()).toEqual([...codex.capabilities.hooks].sort());
  });

  test('ac-3 pass-side: all hosts satisfy parity, exit 0', () => {
    const proc = run(['doctor', 'capability', '--output', 'json']);
    expect(proc.exitCode).toBe(0);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.status).toBe('ok');
    expect(json.findings).toEqual([]);
  });

  test('human output reports ok with host count', () => {
    const proc = run(['doctor', 'capability']);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain('capability: ok');
  });
});

// Fail-side proven at the exact CLI surface users invoke (mirrors
// tests/doctor/surface.test.ts): a temp repo whose hooks/hooks.json drifts from
// claude-code's hardcoded declared set must make the command exit non-zero.
describe('doctor capability (fail-closed at CLI surface)', () => {
  let dir: string;
  let home: string;

  function runIn(args: string[]) {
    return Bun.spawnSync(['bun', 'run', cli, ...args], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, HOME: home },
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-doctor-capability-'));
    home = await mkdtemp(join(tmpdir(), 'ditto-home-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  test('ac-4 fail-side: declared hook not registered drift exits 1', async () => {
    // Register only Stop; claude-code declares 5 → 4 declared_hook_not_registered.
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(
      join(dir, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: hookEntry('bun run stop.ts') } }),
      'utf8',
    );
    const proc = runIn(['doctor', 'capability', '--host', 'claude-code', '--output', 'json']);
    expect(proc.exitCode).toBe(1);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.status).not.toBe('ok');
    const drift = json.findings.filter(
      (f: { kind: string; host: string }) =>
        f.kind === 'declared_hook_not_registered' && f.host === 'claude-code',
    );
    expect(drift.length).toBe(4);
    expect(drift.map((f: { capability: string }) => f.capability).sort()).toEqual([
      'PostToolUse',
      'PreCompact',
      'PreToolUse',
      'UserPromptSubmit',
    ]);
  });

  test('ac-4 fail-side: registered hook not declared drift exits 1', async () => {
    // Register all 5 declared events plus an undeclared SessionStart event →
    // one registered_hook_not_declared finding. Exercises the reverse direction
    // via the CLI without touching the adapter's hardcoded declaration.
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(
      join(dir, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: hookEntry('bun run user-prompt-submit.ts'),
          Stop: hookEntry('bun run stop.ts'),
          PreCompact: hookEntry('bun run pre-compact.ts'),
          PostToolUse: hookEntry('bun run post-tool-use.ts'),
          PreToolUse: hookEntry('bun run pre-tool-use.ts'),
          SessionStart: hookEntry('bun run session-start.ts'),
        },
      }),
      'utf8',
    );
    const proc = runIn(['doctor', 'capability', '--host', 'claude-code', '--output', 'json']);
    expect(proc.exitCode).toBe(1);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.status).not.toBe('ok');
    const drift = json.findings.filter(
      (f: { kind: string; host: string; capability: string }) =>
        f.kind === 'registered_hook_not_declared' &&
        f.host === 'claude-code' &&
        f.capability === 'SessionStart',
    );
    expect(drift.length).toBe(1);
  });
});
