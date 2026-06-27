import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CleanupDirtyRepoError, commitCleanup, commitPerSubRepo } from '~/core/cleanup-archive';
import { landCommit } from '~/core/land-commit';
import type { CleanupIndex } from '~/schemas/cleanup-index';

const MSG = 'land: wi test';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'ditto@example.test']);
  git(dir, ['config', 'user.name', 'DITTO Test']);
}

function head(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']);
}

/** Files recorded in a commit's tree (name-only diff vs its parent / root). */
function committedPaths(dir: string, sha: string): string[] {
  return git(dir, ['show', '--name-only', '--pretty=format:', sha])
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .sort();
}

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-land-'));
  initRepo(repo);
  // .ditto/ (run artifacts) and nested sub-repos must not register as root dirt.
  await writeFile(join(repo, '.gitignore'), 'sub/\nsub2/\n.ditto/\n', 'utf8');
  await writeFile(join(repo, 'README.md'), 'hello\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'initial']);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** Create a nested git sub-repo with one initial commit; return its abs dir. */
async function addSub(name: string): Promise<string> {
  const sub = join(repo, name);
  await mkdir(sub, { recursive: true });
  initRepo(sub);
  await writeFile(join(sub, 'README.md'), 'sub\n', 'utf8');
  git(sub, ['add', '.']);
  git(sub, ['commit', '-q', '-m', 'sub initial']);
  return sub;
}

describe('landCommit — grouping (ac-1)', () => {
  test('one commit per owning sub-repo', async () => {
    const sub = await addSub('sub');
    await writeFile(join(repo, 'app.ts'), 'root\n', 'utf8');
    await writeFile(join(sub, 'lib.ts'), 'sublib\n', 'utf8');

    const res = await landCommit(repo, ['app.ts', 'sub/lib.ts'], MSG);

    expect(res.status).toBe('committed');
    expect(res.commits.length).toBe(2);
    const byRepo = Object.fromEntries(res.commits.map((c) => [c.repo, c]));
    expect(committedPaths(repo, byRepo['.'].sha)).toEqual(['app.ts']);
    expect(committedPaths(sub, byRepo.sub.sha)).toEqual(['lib.ts']);
    // each commit is on its own branch (revertable), not orphaned
    expect(head(repo)).toBe(byRepo['.'].sha);
    expect(head(sub)).toBe(byRepo.sub.sha);
  });
});

describe('landCommit — run-artifact exclusion (ac-1)', () => {
  test('paths under .ditto/local/runs are never committed', async () => {
    await writeFile(join(repo, 'app.ts'), 'root\n', 'utf8');
    await mkdir(join(repo, '.ditto/local/runs/r1'), { recursive: true });
    await writeFile(join(repo, '.ditto/local/runs/r1/manifest.json'), '{}\n', 'utf8');

    const res = await landCommit(repo, ['app.ts', '.ditto/local/runs/r1/manifest.json'], MSG);

    expect(res.status).toBe('committed');
    expect(res.commits.length).toBe(1);
    expect(committedPaths(repo, res.commits[0].sha)).toEqual(['app.ts']);
  });
});

describe('landCommit — unrelated dirty abort (ac-1)', () => {
  test('unrelated working-tree dirt → abort with NO commit', async () => {
    await writeFile(join(repo, 'app.ts'), 'root\n', 'utf8');
    await writeFile(join(repo, 'other.ts'), 'unrelated\n', 'utf8'); // NOT in changeset
    const before = head(repo);

    const res = await landCommit(repo, ['app.ts'], MSG);

    expect(res.status).toBe('aborted_dirty');
    expect(res.commits).toEqual([]);
    expect(res.dirty.flatMap((d) => d.paths)).toContain('other.ts');
    expect(head(repo)).toBe(before); // no commit at all
  });
});

describe('landCommit — empty changeset (ac-1)', () => {
  test('empty changeset → no-op, no commit, no error', async () => {
    const before = head(repo);
    const res = await landCommit(repo, [], MSG);
    expect(res.status).toBe('noop');
    expect(res.commits).toEqual([]);
    expect(head(repo)).toBe(before);
  });

  test('only run-artifact paths → no-op (nothing landable)', async () => {
    const before = head(repo);
    const res = await landCommit(repo, ['.ditto/local/runs/r1/manifest.json'], MSG);
    expect(res.status).toBe('noop');
    expect(head(repo)).toBe(before);
  });
});

describe('landCommit — re-run idempotence + partial reconcile (ac-1)', () => {
  test('re-running the same changeset is a no-op', async () => {
    const sub = await addSub('sub');
    await writeFile(join(repo, 'app.ts'), 'root\n', 'utf8');
    await writeFile(join(sub, 'lib.ts'), 'sublib\n', 'utf8');

    const first = await landCommit(repo, ['app.ts', 'sub/lib.ts'], MSG);
    expect(first.status).toBe('committed');
    const rootHead = head(repo);
    const subHead = head(sub);

    const second = await landCommit(repo, ['app.ts', 'sub/lib.ts'], MSG);
    expect(second.status).toBe('noop');
    expect(second.commits).toEqual([]);
    expect(head(repo)).toBe(rootHead);
    expect(head(sub)).toBe(subHead);
  });

  test('reconciles a partial multi-repo commit (commits only the rest)', async () => {
    const sub = await addSub('sub');
    await writeFile(join(repo, 'app.ts'), 'root\n', 'utf8');
    await writeFile(join(sub, 'lib.ts'), 'sublib\n', 'utf8');

    // Simulate a prior partial land: root already committed, sub still pending.
    git(repo, ['add', '--', 'app.ts']);
    git(repo, ['commit', '-q', '-m', 'prior partial']);
    const rootHead = head(repo);

    const res = await landCommit(repo, ['app.ts', 'sub/lib.ts'], MSG);

    expect(res.status).toBe('committed');
    expect(res.commits.map((c) => c.repo)).toEqual(['sub']);
    expect(head(repo)).toBe(rootHead); // root untouched (already committed)
    expect(committedPaths(sub, res.commits[0].sha)).toEqual(['lib.ts']);
  });
});

describe('landCommit — detached HEAD → failure (ac-1)', () => {
  test('detached HEAD is a surfaced land failure, not a silent commit', async () => {
    git(repo, ['checkout', '-q', '--detach']);
    await writeFile(join(repo, 'app.ts'), 'root\n', 'utf8');
    const before = head(repo);

    const res = await landCommit(repo, ['app.ts'], MSG);

    expect(res.status).toBe('aborted_detached');
    expect(res.commits).toEqual([]);
    expect(res.detached).toEqual(['.']);
    expect(head(repo)).toBe(before); // no orphaned commit
  });
});

describe('landCommit — no push (ac-5)', () => {
  test('a successful land never pushes to the remote', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'ditto-land-remote-'));
    try {
      git(bare, ['init', '-q', '--bare', '-b', 'main']);
      git(repo, ['remote', 'add', 'origin', bare]);
      git(repo, ['push', '-q', 'origin', 'main']);
      const remoteBefore = git(bare, ['rev-parse', 'refs/heads/main']);

      await writeFile(join(repo, 'app.ts'), 'root\n', 'utf8');
      const res = await landCommit(repo, ['app.ts'], MSG);

      expect(res.status).toBe('committed');
      expect(head(repo)).not.toBe(remoteBefore); // local advanced
      expect(git(bare, ['rev-parse', 'refs/heads/main'])).toBe(remoteBefore); // remote untouched
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe('shared commitPerSubRepo reuse (Tidy First extraction)', () => {
  test('commitPerSubRepo is the exported shared landing primitive', () => {
    expect(typeof commitPerSubRepo).toBe('function');
  });

  test('commitCleanup still commits per sub-repo via the shared helper', async () => {
    // A tracked doc, then removed (as classify staging would) — cleanup commits
    // the deletion. Exercises the same commitPerSubRepo extraction land uses.
    await writeFile(join(repo, 'doc.md'), 'doc\n', 'utf8');
    git(repo, ['add', '--', 'doc.md']);
    git(repo, ['commit', '-q', '-m', 'add doc']);
    await rm(join(repo, 'doc.md'));

    const index = {
      entries: [{ owning_repo: null, original_path: 'doc.md' }],
    } as unknown as CleanupIndex;

    const res = commitCleanup(repo, index, 'cleanup: remove doc');

    expect(res.commits.length).toBe(1);
    expect(res.commits[0].repo).toBe('.');
    // doc.md no longer tracked at HEAD
    const tracked = git(repo, ['ls-files']).split('\n');
    expect(tracked).not.toContain('doc.md');
  });
});

// wi_260627sga: ① a gitignored path declared in changed_files must NOT crash the
// land (a gitignored entry can never be committed → drop it). ② the run's own
// tracked byproducts under `.ditto/memory/` ride along with the land commit
// instead of tripping the unrelated-dirt abort, while genuinely foreign dirt STILL
// aborts (the under-declaration safety net stays). cleanup's shared abort is
// unchanged.
describe('landCommit — gitignored filter + run-byproduct absorption (wi_260627sga)', () => {
  // Track `.ditto/memory` (real repos gitignore only `.ditto/local`) so memory
  // events register as working-tree dirt rather than being ignored. A baseline
  // memory file is committed so the dir is tracked — matching production, where a
  // NEW event shows individually in `git status` (default porcelain collapses a
  // wholly-untracked dir to `.ditto/`, which only happens before any memory exists).
  async function trackMemory(): Promise<void> {
    await writeFile(join(repo, '.gitignore'), 'sub/\nsub2/\n.ditto/local/\n', 'utf8');
    await mkdir(join(repo, '.ditto/memory/events'), { recursive: true });
    await writeFile(join(repo, '.ditto/memory/events/baseline.json'), '{"e":0}\n', 'utf8');
    git(repo, ['add', '.gitignore', '.ditto/memory/events/baseline.json']);
    git(repo, ['commit', '-q', '-m', 'track .ditto/memory']);
  }

  test('ac-1: a gitignored changed_files path is dropped (no `git add` crash)', async () => {
    await writeFile(join(repo, 'app.ts'), 'root\n', 'utf8');
    // `.ditto/local/...` is gitignored (beforeEach). Declaring it (e.g. a stale
    // completion.json reference) must be a silent no-op, not a crash.
    await mkdir(join(repo, '.ditto/local/work-items/wi'), { recursive: true });
    await writeFile(join(repo, '.ditto/local/work-items/wi/completion.json'), '{}\n', 'utf8');

    const res = await landCommit(
      repo,
      ['app.ts', '.ditto/local/work-items/wi/completion.json'],
      MSG,
    );

    expect(res.status).toBe('committed');
    expect(res.commits.length).toBe(1);
    // the gitignored path is NOT in the commit; only the real change landed
    expect(committedPaths(repo, res.commits[0].sha)).toEqual(['app.ts']);
  });

  test('ac-2: a tracked-dirty `.ditto/memory/` byproduct is absorbed into the land commit', async () => {
    await trackMemory();
    await writeFile(join(repo, 'app.ts'), 'root\n', 'utf8');
    // a memory event the run wrote — NOT declared in changed_files
    await mkdir(join(repo, '.ditto/memory/events'), { recursive: true });
    await writeFile(join(repo, '.ditto/memory/events/m1.json'), '{"e":1}\n', 'utf8');

    const res = await landCommit(repo, ['app.ts'], MSG);

    expect(res.status).toBe('committed'); // NOT aborted_dirty
    // both the declared change and the byproduct landed in the (root) commit
    const rootSha = res.commits.find((c) => c.repo === '.')?.sha;
    expect(rootSha).toBeDefined();
    expect(committedPaths(repo, rootSha ?? '')).toEqual(
      ['.ditto/memory/events/m1.json', 'app.ts'].sort(),
    );
  });

  test('ac-3: genuinely foreign tracked dirt (not byproduct, not declared) STILL aborts', async () => {
    await trackMemory();
    await writeFile(join(repo, 'app.ts'), 'root\n', 'utf8');
    await writeFile(join(repo, 'other.ts'), 'foreign\n', 'utf8'); // not declared, not byproduct
    const before = head(repo);

    const res = await landCommit(repo, ['app.ts'], MSG);

    expect(res.status).toBe('aborted_dirty');
    expect(res.dirty.flatMap((d) => d.paths)).toContain('other.ts');
    expect(head(repo)).toBe(before); // safety net intact: no commit at all
  });

  test('ac-4: cleanup path (commitPerSubRepo) keeps its strict dirt-abort, unaffected by byproduct absorption', async () => {
    await trackMemory();
    await writeFile(join(repo, 'doc.md'), 'x\n', 'utf8');
    // a dirty `.ditto/memory` file present — for the LAND path it would absorb, but
    // commitPerSubRepo (the shared cleanup primitive) must STILL treat ANY path
    // outside its supplied set as unrelated dirt and throw.
    await mkdir(join(repo, '.ditto/memory/events'), { recursive: true });
    await writeFile(join(repo, '.ditto/memory/events/m1.json'), '{}\n', 'utf8');

    expect(() => commitPerSubRepo(repo, new Map([['.', ['doc.md']]]), MSG)).toThrow(
      CleanupDirtyRepoError,
    );
  });
});
