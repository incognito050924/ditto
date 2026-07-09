import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type TidyDiffStat,
  classifyTidyEntry,
  collectTidyDiffStat,
  writeTidyClassification,
} from '~/acg/tidy/classifier';
import { deriveTidyScope, planTidyOnImplementPass } from '~/core/autopilot-tidy';

const stat = (files: TidyDiffStat['files']): TidyDiffStat => ({ files });

const git = (cwd: string, args: string[]) =>
  Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });

/** Write a repo-relative file (creating parent dirs), then stage+commit all. */
async function commitFiles(
  repo: string,
  files: Record<string, string>,
  message: string,
): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(repo, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
}

/** A temp git repo with a single base commit; returns repo path + base sha. */
async function initRepo(): Promise<{ repo: string; base: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'ditto-tidydiff-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t.t']);
  git(repo, ['config', 'user.name', 't']);
  await commitFiles(repo, { 'placeholder.txt': 'x\n' }, 'base');
  const base = (git(repo, ['rev-parse', 'HEAD']).stdout?.toString() ?? '').trim();
  return { repo, base };
}

describe('classifyTidyEntry — deterministic diff-stat gate (WU-1 ⓪)', () => {
  test('SKIP when no code files are touched (docs/config only)', () => {
    const c = classifyTidyEntry(
      stat([
        { path: 'README.md', added: 100, removed: 5, isCode: false },
        { path: 'config.json', added: 10, removed: 0, isCode: false },
      ]),
    );
    expect(c.decision).toBe('SKIP');
    expect(c.codeFiles).toBe(0);
  });

  test('SKIP when the code diff is below the smallness threshold and few files', () => {
    const c = classifyTidyEntry(stat([{ path: 'src/a.ts', added: 3, removed: 2, isCode: true }]));
    expect(c.decision).toBe('SKIP');
  });

  test('ENTER when code lines exceed the threshold', () => {
    const c = classifyTidyEntry(stat([{ path: 'src/a.ts', added: 40, removed: 10, isCode: true }]));
    expect(c.decision).toBe('ENTER');
  });

  test('ENTER when many code files are touched even if each is small', () => {
    const c = classifyTidyEntry(
      stat([
        { path: 'src/a.ts', added: 2, removed: 1, isCode: true },
        { path: 'src/b.ts', added: 2, removed: 1, isCode: true },
        { path: 'src/c.ts', added: 2, removed: 1, isCode: true },
      ]),
    );
    expect(c.decision).toBe('ENTER');
  });

  test('decision is a pure deterministic function of diff-stat with no slop input (ac-4 / OBJ-08)', () => {
    const s = stat([{ path: 'src/a.ts', added: 40, removed: 0, isCode: true }]);
    expect(classifyTidyEntry(s)).toEqual(classifyTidyEntry(s));
    // ENTER is decided by diff-stat only; the reason never cites a slop signal
    expect(classifyTidyEntry(s).reason.toLowerCase()).not.toContain('slop');
  });

  test('thresholds are overridable for conservative tuning (PM-12)', () => {
    const s = stat([{ path: 'src/a.ts', added: 10, removed: 0, isCode: true }]);
    expect(classifyTidyEntry(s, { minCodeLines: 5, minCodeFiles: 99 }).decision).toBe('ENTER');
    expect(classifyTidyEntry(s, { minCodeLines: 100, minCodeFiles: 99 }).decision).toBe('SKIP');
  });
});

describe('collectTidyDiffStat pathspec scoping — cross-session commits never leak in (wi_260709ft1)', () => {
  // ac-1: pathspec scopes the diff to the given paths; out-of-scope files drop out.
  test('a pathspec restricts diffStat.files to in-scope paths only', async () => {
    const { repo, base } = await initRepo();
    try {
      const bodyIn = `${Array.from({ length: 25 }, (_, i) => `export const a${i} = ${i};`).join('\n')}\n`;
      await commitFiles(
        repo,
        { 'src/in.ts': bodyIn, 'src/out.ts': 'export const leaked = 1;\n' },
        'change both in-scope and out-of-scope',
      );
      const scoped = collectTidyDiffStat(repo, base, 'HEAD', ['src/in.ts']);
      const paths = scoped.files.map((f) => f.path);
      expect(paths).toContain('src/in.ts');
      // ZERO paths outside the pathspec.
      expect(paths.every((p) => p === 'src/in.ts')).toBe(true);
      expect(paths).not.toContain('src/out.ts');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  // ac-2: end-to-end — a cross-session `work.ts` commit does not spawn a refactor node.
  test('deriveTidyScope-scoped diff excludes another session’s file → no spurious refactor node', async () => {
    const { repo, base } = await initRepo();
    try {
      const prismBody = `${Array.from({ length: 25 }, (_, i) => `export const p${i} = ${i};`).join('\n')}\n`;
      const workBody = `${Array.from({ length: 25 }, (_, i) => `export const w${i} = ${i};`).join('\n')}\n`;
      await commitFiles(
        repo,
        { 'src/acg/prism/prism.ts': prismBody, 'src/core/work.ts': workBody },
        'this WI touched prism; another session committed work.ts',
      );
      const surface = ['src/acg/prism/prism.ts'];
      const changedFiles = ['src/acg/prism/prism.ts'];
      const scope = deriveTidyScope(surface, changedFiles);
      const diffStat = collectTidyDiffStat(repo, base, 'HEAD', scope);
      // The unrelated file never entered the diff-stat.
      expect(diffStat.files.map((f) => f.path)).not.toContain('src/core/work.ts');

      const plan = planTidyOnImplementPass({
        implementNodeId: 'N2',
        diffStat,
        acceptanceIds: ['ac-1'],
        existingNodeIds: ['N1', 'N2'],
      });
      // No refactor node targets the cross-session file.
      const targetsWork = plan.nodes.some((n) => (n.file_scope ?? []).includes('src/core/work.ts'));
      expect(targetsWork).toBe(false);
      // And the in-scope file still produces its cleanup node (fix does not over-scope down).
      const targetsPrism = plan.nodes.some((n) =>
        (n.file_scope ?? []).includes('src/acg/prism/prism.ts'),
      );
      expect(targetsPrism).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  // ac-3: empty scope → [] and unscoped fallback is byte-identical to legacy.
  test('deriveTidyScope([], []) is [] and an absent/empty pathspec matches the unscoped legacy diff', async () => {
    expect(deriveTidyScope([], [])).toEqual([]);

    const { repo, base } = await initRepo();
    try {
      await commitFiles(
        repo,
        { 'src/in.ts': 'export const a = 1;\n', 'src/out.ts': 'export const b = 2;\n' },
        'change two files',
      );
      const legacy = collectTidyDiffStat(repo, base, 'HEAD');
      const emptyArr = collectTidyDiffStat(repo, base, 'HEAD', []);
      const emptyDerived = collectTidyDiffStat(repo, base, 'HEAD', deriveTidyScope([], []));
      // Absent, [] and derived-empty pathspec all reproduce the unscoped result.
      expect(emptyArr).toEqual(legacy);
      expect(emptyDerived).toEqual(legacy);
      expect(legacy.files.map((f) => f.path).sort()).toEqual(['src/in.ts', 'src/out.ts']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  // deriveTidyScope: deduped union of change_surface and changed_files.
  test('deriveTidyScope returns the deduped union of change surface and changed files', () => {
    expect(deriveTidyScope(['a.ts', 'b.ts'], ['b.ts', 'c.ts']).sort()).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
    ]);
  });
});

describe('writeTidyClassification — decision persisted as an artifact (WU-1 ⓪ / ac-4)', () => {
  test('writes tidy-classification.json under the work item dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-tidy-'));
    try {
      const c = classifyTidyEntry(
        stat([{ path: 'src/a.ts', added: 40, removed: 0, isCode: true }]),
      );
      const p = await writeTidyClassification(dir, 'wi_test', c);
      const onDisk = JSON.parse(await readFile(p, 'utf8'));
      expect(onDisk.decision).toBe('ENTER');
      expect(p).toContain(join('work-items', 'wi_test'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
