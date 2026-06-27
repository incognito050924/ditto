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

// The capability/hook PARITY finding kinds these pass-side tests are about. We
// filter to these so the assertions are robust to the env-dependent
// codex_plugin_needs_user_action advisory — a machine-local install-state
// finding read from .ditto/local/codex-plugin-status.json that is present only
// when `codex setup` prepared but did not enable the plugin (orthogonal to
// parity; flips the CLI exit code on dev machines but absent on a clean CI repo).
type Finding = { kind: string };
const PARITY_KINDS = [
  'missing_required',
  'declared_hook_not_registered',
  'registered_hook_not_declared',
];
const parityFindings = (findings: Finding[]) =>
  findings.filter((f) => PARITY_KINDS.includes(f.kind));

describe('doctor capability', () => {
  test('ac-2: claude-code json reports 6 hook events and exits 0', () => {
    const proc = run(['doctor', 'capability', '--host', 'claude-code', '--output', 'json']);
    expect(proc.exitCode).toBe(0);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.status).toBe('ok');
    const cc = json.hosts.find((h: { host: string }) => h.host === 'claude-code');
    expect(cc.hook_events.length).toBe(6);
    expect(cc.capabilities.hooks.length).toBe(6);
  });

  test('ac-2: codex json reports 6 hook events and exits 0', () => {
    // M3 (dual-host surface adapter): codex adopted the Claude hook protocol, so
    // it declares the same events and registers them from the shared
    // hooks/hooks.json — declared == registered, 0 drift, exit 0.
    const proc = run(['doctor', 'capability', '--host', 'codex', '--output', 'json']);
    const json = JSON.parse(proc.stdout.toString());
    // No hook/parity drift for codex (the subject). Exit code / total findings are
    // not asserted here: the env-dependent codex install advisory may flip them on
    // a dev machine without changing the hook parity this test verifies.
    expect(parityFindings(json.findings)).toEqual([]);
    const codex = json.hosts.find((h: { host: string }) => h.host === 'codex');
    expect(codex.capabilities.hooks.length).toBe(6);
    expect([...codex.hook_events].sort()).toEqual([...codex.capabilities.hooks].sort());
  });

  test('ac-3 pass-side: all hosts satisfy parity (no parity drift)', () => {
    const proc = run(['doctor', 'capability', '--output', 'json']);
    const json = JSON.parse(proc.stdout.toString());
    // Parity holds for every host: no missing-required or hook-drift findings.
    // (status/exitCode/findings===[] would fold in the env-dependent codex
    // install advisory, so we assert on the parity-relevant findings only.)
    expect(parityFindings(json.findings)).toEqual([]);
  });

  test('human output reports no parity drift', () => {
    const proc = run(['doctor', 'capability']);
    const out = proc.stdout.toString();
    // Either "capability: ok" (clean machine), or only the env-dependent codex
    // install advisory is printed — in both cases NO parity-drift line appears.
    for (const kind of PARITY_KINDS) expect(out).not.toContain(kind);
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
    expect(drift.length).toBe(5);
    expect(drift.map((f: { capability: string }) => f.capability).sort()).toEqual([
      'PostToolUse',
      'PreCompact',
      'PreToolUse',
      'SessionStart',
      'UserPromptSubmit',
    ]);
  });

  test('ac-4 fail-side: registered hook not declared drift exits 1', async () => {
    // Register all 6 declared events plus an undeclared Notification event →
    // one registered_hook_not_declared finding. Exercises the reverse direction
    // via the CLI without touching the adapter's hardcoded declaration.
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(
      join(dir, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: hookEntry('bun run session-start.ts'),
          UserPromptSubmit: hookEntry('bun run user-prompt-submit.ts'),
          Stop: hookEntry('bun run stop.ts'),
          PreCompact: hookEntry('bun run pre-compact.ts'),
          PostToolUse: hookEntry('bun run post-tool-use.ts'),
          PreToolUse: hookEntry('bun run pre-tool-use.ts'),
          Notification: hookEntry('bun run notification.ts'),
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
        f.capability === 'Notification',
    );
    expect(drift.length).toBe(1);
  });
});
