import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = join(process.cwd(), 'src/cli/index.ts');

let workDir: string;

function run(args: string[]) {
  const proc = Bun.spawnSync(['bun', cli, ...args], {
    cwd: workDir,
    env: { ...process.env },
  });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

interface Candidate {
  path: string;
  owning_repo: string | null;
  tracked: boolean;
  signals: { kind: string; detail: string }[];
}
interface ScanOut {
  params: { aggressiveness: number; categories: string[]; scope?: string };
  candidates: Candidate[];
  excluded_protected: string[];
}
interface StageEntry {
  action: string;
  staged_path: string;
}

function parseJson<T>(stdout: string): T {
  return JSON.parse(stdout.slice(stdout.indexOf('{'))) as T;
}

function git(args: string[], cwd = workDir) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

async function write(rel: string, content: string) {
  const abs = join(workDir, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(join(workDir, p))).isFile();
  } catch {
    return false;
  }
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-classify-cli-'));
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('classify scan (ac-3 params, ac-4 protected, ac-7 owning_repo)', () => {
  test('honors --tracked filter: tracked-only excludes untracked docs', async () => {
    await write('reports/tracked.md', 'tracked doc');
    git(['add', 'reports/tracked.md']);
    git(['commit', '-m', 'add tracked']);
    await write('reports/untracked.md', 'untracked doc');

    const tracked = run(['classify', 'scan', '--tracked', 'tracked-only', '--output', 'json']);
    expect(tracked.exitCode).toBe(0);
    const tPaths = parseJson<ScanOut>(tracked.stdout).candidates.map((c) => c.path);
    expect(tPaths).toContain('reports/tracked.md');
    expect(tPaths).not.toContain('reports/untracked.md');

    const untracked = run(['classify', 'scan', '--tracked', 'untracked-only', '--output', 'json']);
    const uPaths = parseJson<ScanOut>(untracked.stdout).candidates.map((c) => c.path);
    expect(uPaths).toContain('reports/untracked.md');
    expect(uPaths).not.toContain('reports/tracked.md');

    const both = run(['classify', 'scan', '--tracked', 'include-untracked', '--output', 'json']);
    const bPaths = parseJson<ScanOut>(both.stdout).candidates.map((c) => c.path);
    expect(bPaths).toContain('reports/tracked.md');
    expect(bPaths).toContain('reports/untracked.md');
  });

  test('--scope glob limits candidates; --categories + --aggressiveness recorded in params', async () => {
    await write('reports/in-scope.md', 'a');
    await write('notes/out-of-scope.md', 'b');
    git(['add', '.']);
    git(['commit', '-m', 'two docs']);

    const res = run([
      'classify',
      'scan',
      '--scope',
      'reports/**',
      '--categories',
      'design,report',
      '--aggressiveness',
      '4',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const out = parseJson<ScanOut>(res.stdout);
    const paths = out.candidates.map((c) => c.path);
    expect(paths).toContain('reports/in-scope.md');
    expect(paths).not.toContain('notes/out-of-scope.md');
    expect(out.params.aggressiveness).toBe(4);
    expect(out.params.categories).toEqual(['design', 'report']);
    expect(out.params.scope).toBe('reports/**');
  });

  test('protected docs are excluded from candidates (ac-4)', async () => {
    await write('reports/normal.md', 'a');
    await write('CLAUDE.md', 'protected');
    await write('reports/design/plan.md', 'protected dir');
    await write('.ditto/knowledge/CONTEXT.md', 'protected ditto');
    git(['add', '.']);
    git(['commit', '-m', 'with protected']);

    const res = run(['classify', 'scan', '--tracked', 'include-untracked', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = parseJson<ScanOut>(res.stdout);
    const paths = out.candidates.map((c) => c.path);
    expect(paths).toContain('reports/normal.md');
    expect(paths).not.toContain('CLAUDE.md');
    expect(paths).not.toContain('reports/design/plan.md');
    // .ditto is also a skipped scan dir; either way it never becomes a candidate.
    expect(paths.some((p) => p.startsWith('.ditto/'))).toBe(false);
    expect(out.excluded_protected).toContain('CLAUDE.md');
    expect(out.excluded_protected).toContain('reports/design/plan.md');
  });

  test('records owning_repo on a sub-repo fixture (ac-7)', async () => {
    // Sub-repo: a nested .git marker under the workspace.
    await mkdir(join(workDir, 'packages/sub/.git'), { recursive: true });
    await write('packages/sub/doc.md', 'sub doc');

    const res = run(['classify', 'scan', '--tracked', 'include-untracked', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = parseJson<ScanOut>(res.stdout);
    const sub = out.candidates.find((c) => c.path === 'packages/sub/doc.md');
    expect(sub).toBeDefined();
    expect(sub?.owning_repo).toBe('packages/sub');
  });
});

describe('classify create-run (ac-1)', () => {
  test('creates run folder + 4 action subfolders + index', async () => {
    const params = JSON.stringify({
      tracked_filter: 'tracked-only',
      categories: ['design'],
      auto_cleanup: false,
      concurrency: 4,
      aggressiveness: 3,
    });
    const res = run(['classify', 'create-run', '--params', params, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = parseJson<{ run_id: string }>(res.stdout);
    expect(out.run_id).toMatch(/^cleanup-\d{8}-\d{6}/);
    const base = `.ditto/local/cleanup/${out.run_id}`;
    for (const action of [
      'delete-candidate',
      'quarantine',
      'absorb-then-discard',
      'unclassified',
    ]) {
      expect((await stat(join(workDir, base, action))).isDirectory()).toBe(true);
    }
    expect(await fileExists(`${base}/index.json`)).toBe(true);
  });
});

async function createRun(): Promise<string> {
  const params = JSON.stringify({
    tracked_filter: 'tracked-only',
    categories: [],
    auto_cleanup: false,
    concurrency: 2,
    aggressiveness: 3,
  });
  const res = run(['classify', 'create-run', '--params', params, '--output', 'json']);
  expect(res.exitCode).toBe(0);
  return parseJson<{ run_id: string }>(res.stdout).run_id;
}

describe('classify stage (ac-4 protected, ac-5 basis)', () => {
  test('stages a normal doc with basis and moves it', async () => {
    await write('reports/old.md', 'stale');
    const runId = await createRun();
    const res = run([
      'classify',
      'stage',
      '--run-id',
      runId,
      '--path',
      'reports/old.md',
      '--action',
      'quarantine',
      '--basis',
      JSON.stringify([{ kind: 'stale', detail: 'old' }]),
      '--summary',
      'superseded',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(await fileExists('reports/old.md')).toBe(false);
    const entry = parseJson<StageEntry>(res.stdout);
    expect(entry.action).toBe('quarantine');
    expect(await fileExists(entry.staged_path)).toBe(true);
  });

  test('refuses a protected path (ac-4), file untouched', async () => {
    await write('CLAUDE.md', 'protected');
    const runId = await createRun();
    const res = run([
      'classify',
      'stage',
      '--run-id',
      runId,
      '--path',
      'CLAUDE.md',
      '--action',
      'quarantine',
      '--basis',
      JSON.stringify([{ kind: 'orphan', detail: 'x' }]),
      '--output',
      'json',
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('protected');
    expect(await fileExists('CLAUDE.md')).toBe(true);
  });

  test('refuses empty basis (ac-5), file untouched', async () => {
    await write('reports/x.md', 'x');
    const runId = await createRun();
    const res = run([
      'classify',
      'stage',
      '--run-id',
      runId,
      '--path',
      'reports/x.md',
      '--action',
      'quarantine',
      '--basis',
      '[]',
      '--output',
      'json',
    ]);
    expect(res.exitCode).not.toBe(0);
    // empty basis fails Zod .min(1) at the arg layer (usage error)
    expect(res.stderr.toLowerCase()).toMatch(/basis|at least/);
    expect(await fileExists('reports/x.md')).toBe(true);
  });
});

describe('auto-cleanup is archive-only — never delete (ac-6 fail-closed)', () => {
  test('--auto refuses delete-candidate and does not move the file', async () => {
    await write('reports/d.md', 'doomed');
    const runId = await createRun();
    const res = run([
      'classify',
      'stage',
      '--run-id',
      runId,
      '--path',
      'reports/d.md',
      '--action',
      'delete-candidate',
      '--basis',
      JSON.stringify([{ kind: 'orphan', detail: 'x' }]),
      '--auto',
      '--output',
      'json',
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('archive');
    // fail-closed: file never moved
    expect(await fileExists('reports/d.md')).toBe(true);
  });

  test('--auto refuses unclassified too (only archive buckets allowed)', async () => {
    await write('reports/u.md', 'undecided');
    const runId = await createRun();
    const res = run([
      'classify',
      'stage',
      '--run-id',
      runId,
      '--path',
      'reports/u.md',
      '--action',
      'unclassified',
      '--basis',
      JSON.stringify([{ kind: 'orphan', detail: 'x' }]),
      '--auto',
      '--output',
      'json',
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(await fileExists('reports/u.md')).toBe(true);
  });

  test('--auto allows archive (quarantine) and moves the file', async () => {
    await write('reports/q.md', 'quarantine me');
    const runId = await createRun();
    const res = run([
      'classify',
      'stage',
      '--run-id',
      runId,
      '--path',
      'reports/q.md',
      '--action',
      'quarantine',
      '--basis',
      JSON.stringify([{ kind: 'orphan', detail: 'x' }]),
      '--auto',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(await fileExists('reports/q.md')).toBe(false);
  });
});
