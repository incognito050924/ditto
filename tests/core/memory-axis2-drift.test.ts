/**
 * Axis-2 (code ↔ SoT) drift detection in `memoryStatus` (wi_260612503 ①).
 *
 * After scan→project, the projection records each source's owning-repo HEAD
 * (`source_revisions[].git_commit`) and content hash. If the code then diverges
 * from that baseline — file edited (working tree dirty) or HEAD moved (commit
 * drift) — status must report `code_dirty`/`code_drift` instead of `fresh`.
 *
 * Fixtures are real git repos under os.tmpdir. Because findRepoRoot prefers a
 * `.ditto` marker, each fixture gets its own `.ditto/` so SoT lands there and
 * scan/project/status all root on the fixture (not the ditto repo).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as gitModule from '~/core/git';
import { memoryStatus } from '~/core/memory-project';
import { scanSources, sourceIdForPath } from '~/core/memory-scan';
import { MemoryProjectionStore, MemorySourceStore } from '~/core/memory-store';

let workDir: string;

/** Source id for a repo-relative path (mirrors scan's id derivation). */
const srcIdFor = (rel: string): string => sourceIdForPath(rel);

function git(args: string[], cwd: string): { stdout: string; exitCode: number } {
  const proc = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { stdout: (proc.stdout?.toString() ?? '').trim(), exitCode: proc.exitCode ?? 1 };
}

/** Init a git repo at `dir`, configure identity, and make one commit of `files`. */
async function initRepoWithFiles(dir: string, files: Record<string, string>): Promise<void> {
  git(['init', '-q'], dir);
  git(['config', 'user.email', 't@t'], dir);
  git(['config', 'user.name', 't'], dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-axis2-'));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('axis-2 drift detection (memoryStatus)', () => {
  test('ac-1: file edited after project (no rescan) → code_dirty (was fresh)', async () => {
    // .ditto marker so SoT roots on the fixture, not the host ditto repo.
    await mkdir(join(workDir, '.ditto'), { recursive: true });
    await initRepoWithFiles(workDir, { 'a.ts': 'export const a = 1;\n' });
    await scanSources(workDir);
    const { projectMemory } = await import('~/core/memory-project');
    await projectMemory(workDir);

    // edit the tracked file WITHOUT rescanning → working tree now dirty.
    await writeFile(join(workDir, 'a.ts'), 'export const a = 2;\n', 'utf8');

    const status = await memoryStatus(workDir);
    expect(status.freshness).toBe('code_dirty');
  });

  test('ac-3: owning-repo HEAD moved past stored git_commit → code_drift', async () => {
    await mkdir(join(workDir, '.ditto'), { recursive: true });
    await initRepoWithFiles(workDir, { 'a.ts': 'export const a = 1;\n' });
    await scanSources(workDir);
    const { projectMemory } = await import('~/core/memory-project');
    await projectMemory(workDir);

    // advance HEAD with a clean new commit (working tree clean again) → drift, not dirty.
    git(['commit', '-q', '--allow-empty', '-m', 'move HEAD'], workDir);

    const status = await memoryStatus(workDir);
    expect(status.freshness).toBe('code_drift');
    expect(status.drifted_repos).toEqual(['.']);
    expect(status.drifted_sources).toContain(srcIdFor('a.ts'));
  });

  test('ac-2: working tree diverges from baseline via git stash → code_dirty', async () => {
    await mkdir(join(workDir, '.ditto'), { recursive: true });
    await initRepoWithFiles(workDir, { 'a.ts': 'export const a = 1;\n' });
    await scanSources(workDir);
    const { projectMemory } = await import('~/core/memory-project');
    await projectMemory(workDir);

    // stash a tracked-file change, then pop it back: HEAD unchanged (no drift), but
    // the working tree now diverges from the projected baseline → code_dirty.
    await writeFile(join(workDir, 'a.ts'), 'export const a = 2;\n', 'utf8');
    expect(git(['stash', '-q'], workDir).exitCode).toBe(0);
    expect((await memoryStatus(workDir)).freshness).toBe('fresh'); // tree restored clean
    expect(git(['stash', 'pop', '-q'], workDir).exitCode).toBe(0);

    const status = await memoryStatus(workDir);
    expect(status.freshness).toBe('code_dirty');
    expect(status.drifted_repos).toEqual(['.']);
  });

  test('ac-4: constant git calls per repo (not per file); no full rehash; .ditto/ excluded at root', async () => {
    await mkdir(join(workDir, '.ditto'), { recursive: true });
    // Three code files in ONE repo — detection must not scale with file count.
    await initRepoWithFiles(workDir, {
      'a.ts': 'export const a = 1;\n',
      'b.ts': 'export const b = 1;\n',
      'c.ts': 'export const c = 1;\n',
    });
    await scanSources(workDir);
    const { projectMemory } = await import('~/core/memory-project');
    await projectMemory(workDir);

    // Move HEAD so the single repo drifts (all three sources share it).
    git(['commit', '-q', '--allow-empty', '-m', 'move'], workDir);

    const revParse = spyOn(gitModule, 'gitRevParse');
    const listChanged = spyOn(gitModule, 'listChangedFiles');
    try {
      const status = await memoryStatus(workDir);
      // One owning repo → exactly one HEAD resolve + one porcelain, regardless of
      // the three files. (Per-repo, not per-file.)
      expect(revParse).toHaveBeenCalledTimes(1);
      expect(listChanged).toHaveBeenCalledTimes(1);
      expect(status.drifted_repos).toEqual(['.']);
      // All three sources attributed to the one drifted repo.
      expect(status.drifted_sources.sort()).toEqual(
        [srcIdFor('a.ts'), srcIdFor('b.ts'), srcIdFor('c.ts')].sort(),
      );
    } finally {
      revParse.mockRestore();
      listChanged.mockRestore();
    }
  });

  test('ac-4: root porcelain ignores .ditto/ churn (tracked SoT is not code drift)', async () => {
    await mkdir(join(workDir, '.ditto'), { recursive: true });
    await initRepoWithFiles(workDir, { 'a.ts': 'export const a = 1;\n' });
    // Track a .ditto/ file so a later change to it shows in porcelain.
    await writeFile(join(workDir, '.ditto', 'tracked.txt'), 'v1\n', 'utf8');
    git(['add', '-A'], workDir);
    git(['commit', '-q', '-m', 'track ditto'], workDir);
    await scanSources(workDir);
    const { projectMemory } = await import('~/core/memory-project');
    await projectMemory(workDir);

    // Dirty ONLY under .ditto/ — code is clean, HEAD unmoved.
    await writeFile(join(workDir, '.ditto', 'tracked.txt'), 'v2\n', 'utf8');
    expect((await memoryStatus(workDir)).freshness).toBe('fresh');
  });

  test('ac-6: SoT writes under .ditto/memory with code unchanged → no false positive', async () => {
    await mkdir(join(workDir, '.ditto'), { recursive: true });
    await initRepoWithFiles(workDir, { 'a.ts': 'export const a = 1;\n' });
    await scanSources(workDir);
    const { projectMemory } = await import('~/core/memory-project');
    await projectMemory(workDir);

    // scan/project wrote SoT + projection under .ditto/ (untracked). Code is clean,
    // HEAD unmoved → those SoT files are not code drift/dirty.
    const before = git(['status', '--porcelain'], workDir);
    expect(before.stdout).toContain('.ditto/'); // .ditto/ churn IS present in porcelain
    expect((await memoryStatus(workDir)).freshness).toBe('fresh');
  });

  test('ac-8: non-git source uses bounded content_hash; detection triggers no rescan/rebuild', async () => {
    // No `git init` → sources get revision=snapshot:<hash>, no git_commit.
    await mkdir(join(workDir, '.ditto'), { recursive: true });
    await writeFile(join(workDir, 'a.ts'), 'export const a = 1;\n', 'utf8');
    await scanSources(workDir);
    const { projectMemory } = await import('~/core/memory-project');
    await projectMemory(workDir);

    const store = new MemorySourceStore(workDir);
    const id = srcIdFor('a.ts');
    const recorded = await store.get(id);
    expect(recorded.git_commit).toBeUndefined();
    expect(recorded.revision.startsWith('snapshot:')).toBe(true);

    // Move the stored content_hash WITHOUT rescanning (simulate a SoT-side change).
    await store.write({ ...recorded, content_hash: 'b'.repeat(64) });

    const status = await memoryStatus(workDir);
    // Bounded compare flags the moved non-git source in drifted_sources...
    expect(status.drifted_sources).toContain(id);
    // ...but it does NOT raise a code_drift/code_dirty git verdict (no HEAD).
    expect(status.freshness).not.toBe('code_drift');
    expect(status.freshness).not.toBe('code_dirty');

    // Detection mutated nothing: the source store still holds our manual hash (no
    // auto rescan would have re-hashed the on-disk file back to its real content).
    const after = await store.get(id);
    expect(after.content_hash).toBe('b'.repeat(64));
  });

  test('ac-10: sub-repo HEAD move is per-owning-repo code_drift (not the cwd shell HEAD)', async () => {
    await mkdir(join(workDir, '.ditto'), { recursive: true });
    // Root repo: keep it clean and ignore the nested sub-repo so only the sub-repo
    // HEAD is the signal (root HEAD must NOT move).
    await initRepoWithFiles(workDir, {
      'root.ts': 'export const r = 1;\n',
      '.gitignore': 'sub/\n',
    });
    const rootHeadBefore = git(['rev-parse', 'HEAD'], workDir).stdout;

    // Nested sub-repo with its own code file.
    const subDir = join(workDir, 'sub');
    await mkdir(subDir, { recursive: true });
    await initRepoWithFiles(subDir, { 'lib.ts': 'export const s = 1;\n' });

    await scanSources(workDir);
    const { projectMemory } = await import('~/core/memory-project');
    await projectMemory(workDir);
    expect((await memoryStatus(workDir)).freshness).toBe('fresh');

    // Move the SUB-repo HEAD only. Root HEAD is untouched.
    git(['commit', '-q', '--allow-empty', '-m', 'sub move'], subDir);
    expect(git(['rev-parse', 'HEAD'], workDir).stdout).toBe(rootHeadBefore); // root unmoved

    const status = await memoryStatus(workDir);
    expect(status.freshness).toBe('code_drift');
    expect(status.drifted_repos).toEqual(['sub']);
    expect(status.drifted_sources).toContain(srcIdFor('sub/lib.ts'));
  });

  // ac-5 regression (wi_260612503 ① / §10-6): axis-1 stale + working tree dirty.
  // The dev tree is almost always dirty, so if axis-2 `code_dirty` outranks axis-1
  // `stale` the verdict reads `code_dirty` → the warm-start gate (which injects
  // code_dirty) would serve a STALE projection as settled. Priority must be
  // code_drift > stale > code_dirty > fresh: axis-1 stale beats code_dirty.
  test('ac-5: axis-1 stale + working tree dirty → stale (not code_dirty)', async () => {
    await mkdir(join(workDir, '.ditto'), { recursive: true });
    await initRepoWithFiles(workDir, { 'a.ts': 'export const a = 1;\n' });
    await scanSources(workDir);
    const { projectMemory } = await import('~/core/memory-project');
    await projectMemory(workDir);
    expect((await memoryStatus(workDir)).freshness).toBe('fresh');

    // Force axis-1 stale: the manifest's serving_version no longer matches the
    // current reduced event-set hash (e.g. an approval landed after projection).
    const store = new MemoryProjectionStore(workDir);
    const manifest = await store.readManifest();
    if (!manifest) throw new Error('manifest expected');
    await store.writeManifest({ ...manifest, serving_version: 'not-the-current-hash' });

    // ...and the working tree is dirty (the normal mid-development state).
    await writeFile(join(workDir, 'a.ts'), 'export const a = 2;\n', 'utf8');

    // stale must win over code_dirty (else a stale graph gets injected).
    const status = await memoryStatus(workDir);
    expect(status.freshness).toBe('stale');
  });

  // Pure code_dirty (axis-1 fresh + dirty tree) must REMAIN code_dirty so the
  // warm-start gate still injects mid-development (ac-5 original intent).
  test('ac-5: pure code_dirty (fresh axis-1 + dirty tree) stays code_dirty', async () => {
    await mkdir(join(workDir, '.ditto'), { recursive: true });
    await initRepoWithFiles(workDir, { 'a.ts': 'export const a = 1;\n' });
    await scanSources(workDir);
    const { projectMemory } = await import('~/core/memory-project');
    await projectMemory(workDir);

    // No serving_version tampering ⇒ axis-1 fresh; only the working tree is dirty.
    await writeFile(join(workDir, 'a.ts'), 'export const a = 2;\n', 'utf8');

    expect((await memoryStatus(workDir)).freshness).toBe('code_dirty');
  });

  // code_drift must still outrank everything (HEAD divergence is the worst trust
  // defect), even when axis-1 is also stale.
  test('ac-5: code_drift outranks axis-1 stale', async () => {
    await mkdir(join(workDir, '.ditto'), { recursive: true });
    await initRepoWithFiles(workDir, { 'a.ts': 'export const a = 1;\n' });
    await scanSources(workDir);
    const { projectMemory } = await import('~/core/memory-project');
    await projectMemory(workDir);

    const store = new MemoryProjectionStore(workDir);
    const manifest = await store.readManifest();
    if (!manifest) throw new Error('manifest expected');
    await store.writeManifest({ ...manifest, serving_version: 'not-the-current-hash' });

    // Move HEAD with a clean commit → code_drift (axis-2 highest).
    git(['commit', '-q', '--allow-empty', '-m', 'move HEAD'], workDir);

    expect((await memoryStatus(workDir)).freshness).toBe('code_drift');
  });
});
