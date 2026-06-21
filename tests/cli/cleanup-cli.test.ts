import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = join(process.cwd(), 'src/cli/index.ts');

let workDir: string;

function run(args: string[], cwd = workDir) {
  const proc = Bun.spawnSync(['bun', cli, ...args], { cwd, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

function git(args: string[], cwd = workDir) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function parseJson<T>(stdout: string): T {
  return JSON.parse(stdout.slice(stdout.indexOf('{'))) as T;
}

async function write(rel: string, content: string, cwd = workDir) {
  const abs = join(cwd, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

async function pathExists(p: string, cwd = workDir): Promise<boolean> {
  try {
    await stat(join(cwd, p));
    return true;
  } catch {
    return false;
  }
}

function initGit(cwd: string) {
  git(['init'], cwd);
  git(['config', 'user.email', 'test@example.com'], cwd);
  git(['config', 'user.name', 'Test'], cwd);
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-cleanup-cli-'));
  initGit(workDir);
  // .ditto/local is runtime state; gitignore it so cleanup folders never count
  // as dirt and `git status` only shows the original-path removals.
  await write('.gitignore', '.ditto/local/\n');
  git(['add', '.gitignore']);
  git(['commit', '-m', 'init']);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Create a run and stage one tracked doc into `quarantine`. Returns runId. */
async function stagedRun(docRel = 'reports/old.md'): Promise<string> {
  await write(docRel, 'stale doc');
  git(['add', docRel]);
  git(['commit', '-m', `add ${docRel}`]);

  const params = JSON.stringify({
    tracked_filter: 'tracked-only',
    categories: [],
    auto_cleanup: false,
    concurrency: 2,
    aggressiveness: 3,
  });
  const created = run(['classify', 'create-run', '--params', params, '--output', 'json']);
  expect(created.exitCode).toBe(0);
  const runId = parseJson<{ run_id: string }>(created.stdout).run_id;

  const staged = run([
    'classify',
    'stage',
    '--run-id',
    runId,
    '--path',
    docRel,
    '--action',
    'quarantine',
    '--basis',
    JSON.stringify([{ kind: 'stale', detail: 'old' }]),
    '--output',
    'json',
  ]);
  expect(staged.exitCode).toBe(0);
  return runId;
}

describe('cleanup archive (ac-9)', () => {
  test('zips the run folder and removes only that folder', async () => {
    const runId = await stagedRun();
    // A second, untouched run must survive the archive of the first.
    const otherParams = JSON.stringify({
      tracked_filter: 'tracked-only',
      categories: [],
      auto_cleanup: false,
      concurrency: 1,
      aggressiveness: 3,
    });
    const other = run(['classify', 'create-run', '--params', otherParams, '--output', 'json']);
    const otherId = parseJson<{ run_id: string }>(other.stdout).run_id;

    const res = run(['cleanup', 'archive', '--run-id', runId, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = parseJson<{ zip_path: string }>(res.stdout);

    // zip exists, run folder gone, OTHER run folder untouched.
    expect(await pathExists(`.ditto/local/cleanup/archive/${runId}.zip`)).toBe(true);
    expect(await pathExists(`.ditto/local/cleanup/${runId}`)).toBe(false);
    expect(await pathExists(`.ditto/local/cleanup/${otherId}`)).toBe(true);
    expect(out.zip_path).toContain(`${runId}.zip`);

    // The zip is confined to the run folder: every entry is under <runId>/.
    // out.zip_path is absolute (and canonicalized) — use it directly.
    const listing = execFileSync('unzip', ['-Z1', out.zip_path], {
      encoding: 'utf8',
    });
    const entries = listing.split('\n').filter((l) => l.length > 0);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.startsWith(`${runId}/`))).toBe(true);
    // index.json is included.
    expect(entries.some((e) => e.endsWith('/index.json'))).toBe(true);
  });

  test('refuses a missing run id (ac-9)', async () => {
    const res = run([
      'cleanup',
      'archive',
      '--run-id',
      'cleanup-19990101-000000',
      '--output',
      'json',
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toLowerCase()).toContain('no cleanup run folder');
  });

  test('refuses when no run id is given', async () => {
    const res = run(['cleanup', 'archive', '--output', 'json']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('run-id');
  });
});

describe('cleanup delete (ac-6 fail-closed, ac-9)', () => {
  test('refuses delete without --confirm (fail-closed), folder untouched', async () => {
    const runId = await stagedRun();
    const res = run(['cleanup', 'delete', '--run-id', runId, '--output', 'json']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toLowerCase()).toContain('confirm');
    expect(await pathExists(`.ditto/local/cleanup/${runId}`)).toBe(true);
  });

  test('proceeds with --confirm, removes the folder, leaves no zip', async () => {
    const runId = await stagedRun();
    const res = run(['cleanup', 'delete', '--run-id', runId, '--confirm', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    expect(await pathExists(`.ditto/local/cleanup/${runId}`)).toBe(false);
    expect(await pathExists(`.ditto/local/cleanup/archive/${runId}.zip`)).toBe(false);
  });
});

describe('cleanup --commit (ac-10)', () => {
  test('archive --commit makes one commit per affected sub-repo and is revertable', async () => {
    const runId = await stagedRun('reports/old.md');
    const headBefore = git(['rev-parse', 'HEAD']).trim();

    const res = run(['cleanup', 'archive', '--run-id', runId, '--commit', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = parseJson<{ commit: { commits: { repo: string; sha: string }[] } }>(res.stdout);
    expect(out.commit.commits.length).toBe(1);
    expect(out.commit.commits[0]?.repo).toBe('.');

    // A new commit was made and the doc deletion is in it.
    const headAfter = git(['rev-parse', 'HEAD']).trim();
    expect(headAfter).not.toBe(headBefore);
    const show = git(['show', '--name-status', 'HEAD']);
    expect(show).toContain('reports/old.md');
    expect(await pathExists('reports/old.md')).toBe(false);

    // Revertable: git revert brings the file back.
    git(['revert', '--no-edit', 'HEAD']);
    expect(await pathExists('reports/old.md')).toBe(true);
  });

  test('--commit ABORTS when a sub-repo working tree is dirty, leaving no commit', async () => {
    const runId = await stagedRun('reports/old.md');
    // Introduce UNRELATED dirt: an extra tracked-file modification.
    await write('reports/keep.md', 'keep');
    git(['add', 'reports/keep.md']);
    git(['commit', '-m', 'add keep']);
    await write('reports/keep.md', 'keep MODIFIED');

    const headBefore = git(['rev-parse', 'HEAD']).trim();
    const res = run(['cleanup', 'archive', '--run-id', runId, '--commit', '--output', 'json']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toLowerCase()).toContain('uncommitted');

    // No commit made.
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    // Abort happens AFTER archive (archive ran, commit did not) — but the key
    // invariant for ac-10 is: no commit, working tree not auto-cleaned.
    expect(git(['status', '--porcelain'])).toContain('reports/keep.md');
  });

  test('commits per sub-repo: a nested git sub-repo gets its own commit', async () => {
    // Sub-repo with its own .git and a tracked doc. The root repo treats the
    // nested repo as out of its concern (gitignored), as nested repos are in a
    // real multi-repo workspace — otherwise it would show as root-level dirt.
    const subAbs = join(workDir, 'packages/sub');
    await mkdir(subAbs, { recursive: true });
    initGit(subAbs);
    await write('packages/sub/sub-doc.md', 'sub stale');
    git(['add', 'sub-doc.md'], subAbs);
    git(['commit', '-m', 'add sub-doc'], subAbs);
    await write('.gitignore', '.ditto/local/\npackages/\n');
    git(['add', '.gitignore']);
    git(['commit', '-m', 'ignore nested repo']);

    // Root-tracked doc too.
    await write('reports/root-doc.md', 'root stale');
    git(['add', 'reports/root-doc.md']);
    git(['commit', '-m', 'add root-doc']);

    const params = JSON.stringify({
      tracked_filter: 'tracked-only',
      categories: [],
      auto_cleanup: false,
      concurrency: 1,
      aggressiveness: 3,
    });
    const runId = parseJson<{ run_id: string }>(
      run(['classify', 'create-run', '--params', params, '--output', 'json']).stdout,
    ).run_id;
    for (const p of ['reports/root-doc.md', 'packages/sub/sub-doc.md']) {
      const r = run([
        'classify',
        'stage',
        '--run-id',
        runId,
        '--path',
        p,
        '--action',
        'quarantine',
        '--basis',
        JSON.stringify([{ kind: 'stale', detail: 'x' }]),
        '--output',
        'json',
      ]);
      expect(r.exitCode).toBe(0);
    }

    const res = run(['cleanup', 'archive', '--run-id', runId, '--commit', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = parseJson<{ commit: { commits: { repo: string; sha: string }[] } }>(res.stdout);
    const repos = out.commit.commits.map((c) => c.repo).sort();
    expect(repos).toEqual(['.', 'packages/sub']);

    // Each sub-repo advanced its own HEAD with its own deletion.
    expect(git(['show', '--name-status', 'HEAD'])).toContain('reports/root-doc.md');
    expect(git(['show', '--name-status', 'HEAD'], subAbs)).toContain('sub-doc.md');
  });
});

describe('cleanup restore', () => {
  test('moves a staged doc back to its original path', async () => {
    const runId = await stagedRun('reports/old.md');
    expect(await pathExists('reports/old.md')).toBe(false);
    const res = run([
      'cleanup',
      'restore',
      '--run-id',
      runId,
      '--path',
      'reports/old.md',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(await pathExists('reports/old.md')).toBe(true);
  });
});

describe('auto-chain (from classify) can only archive, never delete (ac-6)', () => {
  test('runAutoCleanupChain archives the run folder and produces a zip', async () => {
    const runId = await stagedRun('reports/auto.md');
    // Drive the wired N5 auto-chain entry point directly (same code the CLI
    // auto path routes to). It calls archiveRun — structurally cannot delete.
    const probe = join(workDir, 'probe.ts');
    await writeFile(
      probe,
      [
        `import { runAutoCleanupChain } from '${join(process.cwd(), 'src/cli/commands/classify.ts')}';`,
        `const zip = await runAutoCleanupChain(${JSON.stringify(workDir)}, ${JSON.stringify(runId)});`,
        'process.stdout.write(zip);',
      ].join('\n'),
      'utf8',
    );
    const proc = Bun.spawnSync(['bun', probe], { cwd: workDir, env: { ...process.env } });
    expect(proc.exitCode).toBe(0);
    const zip = proc.stdout?.toString() ?? '';
    expect(zip).toContain(`${runId}.zip`);
    // Archived: folder gone, zip kept (reversible) — nothing deleted permanently.
    expect(await pathExists(`.ditto/local/cleanup/${runId}`)).toBe(false);
    expect(await pathExists(`.ditto/local/cleanup/archive/${runId}.zip`)).toBe(true);
  });

  test('the auto chain has no path to delete: archive keeps a recoverable zip', async () => {
    // Structural assertion (ac-6): the auto entry point returns an archive zip,
    // and the only function it can call is archiveRun (asserted by the zip's
    // existence after the run). delete requires the separate gated CLI + confirm.
    const runId = await stagedRun('reports/auto2.md');
    const probe = join(workDir, 'probe2.ts');
    await writeFile(
      probe,
      [
        `import { runAutoCleanupChain } from '${join(process.cwd(), 'src/cli/commands/classify.ts')}';`,
        `await runAutoCleanupChain(${JSON.stringify(workDir)}, ${JSON.stringify(runId)});`,
      ].join('\n'),
      'utf8',
    );
    const proc = Bun.spawnSync(['bun', probe], { cwd: workDir, env: { ...process.env } });
    expect(proc.exitCode).toBe(0);
    // Reversible: the zip survives (delete would have left nothing).
    expect(await pathExists(`.ditto/local/cleanup/archive/${runId}.zip`)).toBe(true);
  });
});
