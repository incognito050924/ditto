import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  captureGitDiff,
  diffVsRef,
  gitRevParse,
  isWorkingTreeClean,
  listChangedFiles,
  listChangedFilesVsRef,
} from './git';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Fresh temp git repo with one initial commit (identity local to the repo). */
async function withGitRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), 'rebuild-git-'));
  try {
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'test');
    await writeFile(join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'initial');
    await fn(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function writeNested(repo: string, rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(repo, rel)), { recursive: true });
  await writeFile(join(repo, rel), content);
}

describe('listChangedFiles', () => {
  test('lists modified and untracked files sorted', async () => {
    await withGitRepo(async (repo) => {
      await writeFile(join(repo, 'base.txt'), 'changed\n');
      await writeFile(join(repo, 'new.txt'), 'new\n');
      expect(listChangedFiles(repo)).toEqual(['base.txt', 'new.txt']);
    });
  });

  test('untrackedOnly keeps only the ?? cohort', async () => {
    await withGitRepo(async (repo) => {
      await writeFile(join(repo, 'base.txt'), 'changed\n');
      await writeFile(join(repo, 'new.txt'), 'new\n');
      expect(listChangedFiles(repo, { untrackedOnly: true })).toEqual(['new.txt']);
    });
  });

  test('untrackedOnly dequotes a non-ASCII porcelain path to utf-8', async () => {
    await withGitRepo(async (repo) => {
      git(repo, 'config', 'core.quotepath', 'true');
      await writeFile(join(repo, '한글.txt'), 'x\n');
      expect(listChangedFiles(repo, { untrackedOnly: true })).toEqual(['한글.txt']);
    });
  });

  test('excludeDittoRuns filters .ditto/local/runs/ paths', async () => {
    await withGitRepo(async (repo) => {
      // Track a sibling so git collapses the untracked run dir to `.ditto/local/runs/`
      // (the topmost wholly-untracked dir), matching the prefix the filter excludes.
      await writeNested(repo, '.ditto/local/keep.txt', 'x\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'track .ditto/local');
      await writeNested(repo, '.ditto/local/runs/r1/log.json', '{}');
      await writeFile(join(repo, 'kept.txt'), 'x\n');
      expect(listChangedFiles(repo, { excludeDittoRuns: true })).toEqual(['kept.txt']);
      expect(
        listChangedFiles(repo, { untrackedOnly: true, excludeDittoRuns: true }),
      ).toEqual(['kept.txt']);
    });
  });

  test('returns [] outside a git repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rebuild-nongit-'));
    try {
      expect(listChangedFiles(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('listChangedFilesVsRef', () => {
  test('lists tracked files changed vs the ref, ignoring untracked', async () => {
    await withGitRepo(async (repo) => {
      const head = git(repo, 'rev-parse', 'HEAD').trim();
      await writeFile(join(repo, 'base.txt'), 'changed\n');
      await writeFile(join(repo, 'untracked.txt'), 'x\n');
      expect(listChangedFilesVsRef(repo, head)).toEqual(['base.txt']);
    });
  });

  test('returns [] on an unresolvable ref', async () => {
    await withGitRepo(async (repo) => {
      expect(listChangedFilesVsRef(repo, 'no-such-ref')).toEqual([]);
    });
  });
});

describe('diffVsRef', () => {
  test('returns the full text diff vs the ref', async () => {
    await withGitRepo(async (repo) => {
      await writeFile(join(repo, 'base.txt'), 'changed\n');
      const diff = diffVsRef(repo, 'HEAD');
      expect(diff).toContain('--- a/base.txt');
      expect(diff).toContain('+changed');
    });
  });

  test('returns empty string on an unresolvable ref', async () => {
    await withGitRepo(async (repo) => {
      expect(diffVsRef(repo, 'no-such-ref')).toBe('');
    });
  });
});

describe('gitRevParse', () => {
  test('resolves HEAD to a 40-char sha', async () => {
    await withGitRepo(async (repo) => {
      const sha = gitRevParse(repo, 'HEAD');
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(sha).toBe(git(repo, 'rev-parse', 'HEAD').trim());
    });
  });

  test('throws on an unresolvable ref', async () => {
    await withGitRepo(async (repo) => {
      expect(() => gitRevParse(repo, 'no-such-ref')).toThrow();
    });
  });
});

describe('isWorkingTreeClean', () => {
  test('true on a fresh commit with no changes', async () => {
    await withGitRepo(async (repo) => {
      expect(isWorkingTreeClean(repo)).toBe(true);
    });
  });

  test('false when an untracked file exists', async () => {
    await withGitRepo(async (repo) => {
      await writeFile(join(repo, 'new.txt'), 'x\n');
      expect(isWorkingTreeClean(repo)).toBe(false);
    });
  });

  test('false outside a git repo (fail-closed)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rebuild-nongit-'));
    try {
      expect(isWorkingTreeClean(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('captureGitDiff', () => {
  test('captures the working-tree diff vs HEAD', async () => {
    await withGitRepo(async (repo) => {
      await writeFile(join(repo, 'base.txt'), 'changed\n');
      expect(captureGitDiff(repo)).toContain('+changed');
    });
  });

  test('falls back to an index diff when HEAD does not exist (no commits)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'rebuild-git-nohead-'));
    try {
      git(repo, 'init', '-q', '-b', 'main');
      await writeFile(join(repo, 'a.txt'), 'one\n');
      git(repo, 'add', 'a.txt');
      await writeFile(join(repo, 'a.txt'), 'two\n');
      expect(captureGitDiff(repo)).toContain('+two');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('returns empty string outside a git repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rebuild-nongit-'));
    try {
      expect(captureGitDiff(dir)).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
