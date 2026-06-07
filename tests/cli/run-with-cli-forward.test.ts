import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Drive the COMPILED binary, not `bun src/cli/index.ts`: spawning `bun` from
// inside the `bun test` runner loses the child's stdout (bun-in-bun stdio
// capture), which masks the citty `--help` output. The self-contained binary is
// independent of the runner and is the actual shipped artifact (wi_2606068sy).
const dittoBin = join(process.cwd(), 'bin', 'ditto');
beforeAll(() => {
  if (!existsSync(dittoBin)) {
    spawnSync('bun', ['run', 'build:bin'], { cwd: process.cwd(), stdio: 'ignore' });
  }
});

let dir: string;
let binDir: string;
let argsFile: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
}

async function createWorkItem(id: string): Promise<void> {
  const wiDir = join(dir, '.ditto', 'local', 'work-items', id);
  await mkdir(wiDir, { recursive: true });
  const body = {
    schema_version: '0.1.0',
    id,
    title: 'cli-forward test',
    source_request: 'wi_v03cliforward regression',
    goal: 'verify -- tail is forwarded to provider',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'forwarded', verdict: 'unverified', evidence: [] },
    ],
    status: 'draft',
    owner_profile: 'workspace-write',
    child_ids: [],
    changed_files: [],
    risks: [],
    runs: [],
    created_at: '2026-05-24T12:00:00.000Z',
    updated_at: '2026-05-24T12:00:00.000Z',
  };
  await writeFile(join(wiDir, 'work-item.json'), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-cli-forward-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await writeFile(join(dir, 'README.md'), 'init\n', 'utf8');
  await mkdir(join(dir, '.ditto'), { recursive: true });
  git(['add', '.']);
  git(['commit', '-qm', 'init']);

  binDir = join(dir, 'bin');
  argsFile = join(dir, 'codex-args.txt');
  await mkdir(binDir, { recursive: true });
  const mockCodex = `#!/usr/bin/env sh\nprintf '%s\\n' "$@" > "$DITTO_TEST_ARGS_FILE"\nexit 0\n`;
  await writeFile(join(binDir, 'codex'), mockCodex, 'utf8');
  await chmod(join(binDir, 'codex'), 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function spawnDitto(args: string[]): {
  stdout: string;
  stderr: string;
  combined: string;
  exitCode: number | null;
} {
  // node spawnSync (captures BOTH streams). Inside the `bun test` runner (bun
  // ≥1.1) citty routes its `--help` text to stderr rather than stdout (the
  // long-known "citty help is bun-version-sensitive" case; a direct
  // `dist/ditto --help` still prints to stdout). So help assertions check the
  // combined stream — the help content must appear, regardless of which fd
  // carried it (wi_2606068sy).
  const r = spawnSync(dittoBin, args, {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      DITTO_TEST_ARGS_FILE: argsFile,
    },
    encoding: 'utf8',
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, stderr, combined: stdout + stderr, exitCode: r.status };
}

async function readMockCodexArgs(): Promise<string[]> {
  const text = await Bun.file(argsFile).text();
  return text.split('\n').filter(Boolean);
}

describe('ditto run with forwards -- tail to provider without citty consuming it', () => {
  test('forwards --help after -- and produces a run manifest', async () => {
    await createWorkItem('wi_clitesthelp');
    const result = spawnDitto([
      'run',
      'with',
      '--provider',
      'codex',
      '--profile',
      'workspace-write',
      '--workItem',
      'wi_clitesthelp',
      '--output',
      'json',
      '--',
      '--help',
    ]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.run_id).toMatch(/^run_/);
    expect(payload.exit_code).toBe(0);

    const codexArgs = await readMockCodexArgs();
    expect(codexArgs).toContain('--sandbox');
    expect(codexArgs).toContain('workspace-write');
    expect(codexArgs).toContain('--help');

    const manifest = JSON.parse(await Bun.file(join(dir, payload.manifest_path)).text());
    expect(manifest.exit_code).toBe(0);
    expect(manifest.entrypoint).toBe('codex');
  });

  test('forwards --version after --', async () => {
    await createWorkItem('wi_clitestver1');
    const result = spawnDitto([
      'run',
      'with',
      '--provider',
      'codex',
      '--profile',
      'workspace-write',
      '--workItem',
      'wi_clitestver1',
      '--output',
      'json',
      '--',
      '--version',
    ]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.run_id).toMatch(/^run_/);

    const codexArgs = await readMockCodexArgs();
    expect(codexArgs).toContain('--version');
  });

  test('forwards tokens that collide with wrapper flag names', async () => {
    await createWorkItem('wi_clitestcoll');
    const result = spawnDitto([
      'run',
      'with',
      '--provider',
      'codex',
      '--profile',
      'workspace-write',
      '--workItem',
      'wi_clitestcoll',
      '--output',
      'json',
      '--',
      '--output',
      'pretty',
      '--profile',
      'fast',
      'exec',
    ]);
    expect(result.exitCode).toBe(0);

    const codexArgs = await readMockCodexArgs();
    expect(codexArgs).toContain('--output');
    expect(codexArgs).toContain('pretty');
    expect(codexArgs).toContain('--profile');
    expect(codexArgs).toContain('fast');
    expect(codexArgs).toContain('exec');
  });

  test('without -- the wrapper-side --help still shows wrapper help and no manifest is created', async () => {
    await createWorkItem('wi_clitestsane');
    const result = spawnDitto(['run', 'with', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.combined).toContain('Run a provider command');
    expect(result.combined).toContain('--provider');

    let runsDirExists = true;
    try {
      execFileSync('ls', [join(dir, '.ditto', 'local', 'runs')], { stdio: 'ignore' });
    } catch {
      runsDirExists = false;
    }
    expect(runsDirExists).toBe(false);
  });
});
