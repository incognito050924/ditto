import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLEANUP_ACTIONS,
  CleanupBasisRequiredError,
  CleanupProtectedPathError,
  CleanupStore,
  isProtectedPath,
} from '~/core/cleanup-store';
import type { CleanupRunParams } from '~/schemas/cleanup-index';

let workDir: string;
let store: CleanupStore;

const params: CleanupRunParams = {
  tracked_filter: 'tracked-only',
  categories: ['design'],
  auto_cleanup: false,
  concurrency: 4,
  aggressiveness: 3,
};

const basis = [{ kind: 'stale' as const, detail: 'old' }];

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-cleanup-'));
  store = new CleanupStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('createRun (ac-1)', () => {
  test('creates run folder + 4 action subfolders + index', async () => {
    const runId = await store.createRun(params, new Date('2026-06-20T12:00:00Z'));
    expect(runId).toMatch(/^cleanup-\d{8}-\d{6}$/);
    const runDir = store.runDir(runId);
    expect(await dirExists(runDir)).toBe(true);
    for (const action of CLEANUP_ACTIONS) {
      expect(await dirExists(join(runDir, action))).toBe(true);
    }
    const idx = await store.readIndex(runId);
    expect(idx.entries).toEqual([]);
    expect(idx.params.aggressiveness).toBe(3);
  });

  test('sub-second collision produces distinct folders', async () => {
    const now = new Date('2026-06-20T12:00:00Z');
    const a = await store.createRun(params, now);
    const b = await store.createRun(params, now);
    expect(a).not.toBe(b);
    expect(await dirExists(store.runDir(a))).toBe(true);
    expect(await dirExists(store.runDir(b))).toBe(true);
  });
});

describe('stageDoc (ac-2)', () => {
  test('moves file and writes 1:1 index entry; restore round-trips', async () => {
    const runId = await store.createRun(params);
    const origRel = 'reports/old.md';
    const origAbs = join(workDir, origRel);
    await mkdir(join(workDir, 'reports'), { recursive: true });
    await writeFile(origAbs, 'stale content', 'utf8');

    const entry = await store.stageDoc(runId, {
      absPath: origAbs,
      action: 'delete-candidate',
      summary: 'superseded',
      basis,
      aggressiveness: 3,
    });

    // moved, not copied
    expect(await fileExists(origAbs)).toBe(false);
    const stagedAbs = join(workDir, entry.staged_path);
    expect(await fileExists(stagedAbs)).toBe(true);

    // 1:1 — index reflects exactly the moved file
    const idx = await store.readIndex(runId);
    expect(idx.entries).toHaveLength(1);
    expect(idx.entries[0]?.original_path).toBe(origRel);
    expect(idx.entries[0]?.staged_path).toBe(entry.staged_path);

    // restore round-trips
    await store.restore(runId, origRel);
    expect(await fileExists(origAbs)).toBe(true);
    expect(await fileExists(stagedAbs)).toBe(false);
    expect(await Bun.file(origAbs).text()).toBe('stale content');
  });

  test('each stageDoc persists immediately (entry count grows per call)', async () => {
    const runId = await store.createRun(params);
    await mkdir(join(workDir, 'reports'), { recursive: true });
    for (const n of ['a.md', 'b.md', 'c.md']) {
      const abs = join(workDir, 'reports', n);
      await writeFile(abs, n, 'utf8');
      await store.stageDoc(runId, {
        absPath: abs,
        action: 'quarantine',
        summary: 's',
        basis,
        aggressiveness: 2,
      });
    }
    const idx = await store.readIndex(runId);
    expect(idx.entries).toHaveLength(3);
    // 1:1 — exactly 3 files staged under quarantine
    expect(idx.entries.every((e) => e.action === 'quarantine')).toBe(true);
  });
});

describe('protected-set inviolability (ac-4)', () => {
  const protectedRels = [
    'CLAUDE.md',
    'AGENTS.md',
    'README.md',
    'README',
    '.ditto/knowledge/CONTEXT.md',
    '.ditto/knowledge/adr/ADR-0001.md',
    'reports/design/plan.md',
    'reports/contracts/spec.md',
  ];

  test('isProtectedPath flags every protected input', () => {
    for (const rel of protectedRels) {
      expect(isProtectedPath(rel)).toBe(true);
    }
    expect(isProtectedPath('reports/old.md')).toBe(false);
    expect(isProtectedPath('reports/scratch/notes.md')).toBe(false);
  });

  test('stageDoc refuses every protected path regardless of aggressiveness', async () => {
    const runId = await store.createRun(params);
    for (const rel of protectedRels) {
      const abs = join(workDir, rel);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, 'protected', 'utf8');
      let threw = false;
      try {
        await store.stageDoc(runId, {
          absPath: abs,
          action: 'delete-candidate',
          summary: 'x',
          basis,
          aggressiveness: 5,
        });
      } catch (err) {
        threw = true;
        expect(err).toBeInstanceOf(CleanupProtectedPathError);
      }
      expect(threw).toBe(true);
      // file untouched
      expect(await fileExists(abs)).toBe(true);
    }
    const idx = await store.readIndex(runId);
    expect(idx.entries).toHaveLength(0);
  });
});

describe('basis-required (ac-5)', () => {
  test('stageDoc refuses empty basis and does not move the file', async () => {
    const runId = await store.createRun(params);
    const abs = join(workDir, 'reports', 'x.md');
    await mkdir(join(workDir, 'reports'), { recursive: true });
    await writeFile(abs, 'x', 'utf8');
    await expect(
      store.stageDoc(runId, {
        absPath: abs,
        action: 'delete-candidate',
        summary: 'no basis',
        basis: [],
        aggressiveness: 3,
      }),
    ).rejects.toBeInstanceOf(CleanupBasisRequiredError);
    expect(await fileExists(abs)).toBe(true);
    expect((await store.readIndex(runId)).entries).toHaveLength(0);
  });
});

describe('owning_repo resolution (ac-7)', () => {
  test('resolves and records the nearest sub-repo for a doc', async () => {
    const runId = await store.createRun(params);
    // sub-repo fixture: a dir with a .git marker under the workspace
    const subRepoRel = 'packages/sub';
    const subRepoAbs = join(workDir, subRepoRel);
    await mkdir(join(subRepoAbs, '.git'), { recursive: true });
    const docAbs = join(subRepoAbs, 'doc.md');
    await writeFile(docAbs, 'sub doc', 'utf8');

    const entry = await store.stageDoc(runId, {
      absPath: docAbs,
      action: 'unclassified',
      summary: 'in sub-repo',
      basis,
      aggressiveness: 1,
    });
    expect(entry.owning_repo).toBe(subRepoRel);
    const idx = await store.readIndex(runId);
    expect(idx.entries[0]?.owning_repo).toBe(subRepoRel);
  });

  test('owning_repo null when no .git ancestor under workspace root', async () => {
    const runId = await store.createRun(params);
    const abs = join(workDir, 'reports', 'loose.md');
    await mkdir(join(workDir, 'reports'), { recursive: true });
    await writeFile(abs, 'loose', 'utf8');
    const entry = await store.stageDoc(runId, {
      absPath: abs,
      action: 'quarantine',
      summary: 's',
      basis,
      aggressiveness: 1,
    });
    expect(entry.owning_repo).toBeNull();
  });
});
