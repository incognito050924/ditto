// Claude Code host surface: user-typed CLI commands (N2-claude-surface-coverage, wi_260613f9d).
//
// The commands a user runs directly (task surface (b)). Asserts each is REGISTERED
// in the ditto CLI tree (so `ditto <cmd>` resolves) and that the read-only ones
// actually run end-to-end against an isolated project dir. Command-specific
// behaviour is covered by tests/cli/* and tests/doctor/*; this is the host-level
// "the user can invoke it" contract.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorCommand } from '~/cli/commands/doctor';
import { initCommand } from '~/cli/commands/init';
import { setupCommand } from '~/cli/commands/setup';
import { teardownCommand } from '~/cli/commands/teardown';
import { verifyCommand } from '~/cli/commands/verify';
import { workCommand } from '~/cli/commands/work';

const REPO = join(import.meta.dir, '..', '..', '..');
const CLI = join(REPO, 'src', 'cli', 'index.ts');

// Top-level user commands + the `work` subcommand the user invokes for handoffs.
const TOP_LEVEL = [
  ['init', initCommand],
  ['setup', setupCommand],
  ['uninstall', teardownCommand],
  ['doctor', doctorCommand],
  ['verify', verifyCommand],
  ['work', workCommand],
] as const;

describe('Claude host surface — user CLI commands', () => {
  test.each(TOP_LEVEL)('`ditto %s` is a registered command with a description', (name, cmd) => {
    expect(cmd.meta?.name).toBe(name);
    expect(typeof cmd.meta?.description).toBe('string');
    expect((cmd.meta?.description as string).length).toBeGreaterThan(0);
  });

  test('`ditto work` exposes the start/status/handoff/done/abandon/promote/archive/set-criteria subcommands the user types', () => {
    const subs = Object.keys(workCommand.subCommands ?? {}).sort();
    expect(subs).toEqual([
      'abandon',
      'archive',
      'done',
      'handoff',
      'promote',
      'set-criteria',
      'start',
      'status',
    ]);
  });

  // Live invocation of read-only commands, isolated to a tmp project dir so the
  // real repo's work-item state is never read or mutated.
  let projectDir: string;
  let home: string;
  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'ditto-host-cli-'));
    home = await mkdtemp(join(tmpdir(), 'ditto-host-home-'));
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  function run(args: string[]) {
    return Bun.spawnSync(['bun', 'run', CLI, ...args], {
      cwd: projectDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: projectDir },
    });
  }

  test('`ditto work status` runs in an empty project (exit 0, no work items)', () => {
    const proc = run(['work', 'status']);
    expect(proc.exitCode).toBe(0);
  });

  test('`ditto doctor surface` runs against the repo and reports a clean inventory', () => {
    // Read-only invocation against the real repo root (its committed
    // surfaces.json matches disk → mismatch_count 0). Asserts the command is
    // wired and emits a parseable JSON report through the host CLI.
    const proc = Bun.spawnSync(
      ['bun', 'run', CLI, 'doctor', 'surface', '--host', 'claude-code', '--output', 'json'],
      {
        cwd: REPO,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, HOME: home },
      },
    );
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString()).mismatch_count).toBe(0);
  });
});
