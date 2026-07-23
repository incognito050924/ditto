import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import {
  RepoRootNotFoundError,
  SchemaValidationError,
  atomicWriteText,
  ensureDir,
  findRepoRoot,
  readJson,
  writeJson,
} from './fs';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'rebuild-fs-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('ensureDir', () => {
  test('creates a nested directory that does not exist yet', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, 'a', 'b', 'c');
      await ensureDir(target);
      expect((await stat(target)).isDirectory()).toBe(true);
    });
  });

  test('is idempotent on an existing directory', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, 'a');
      await ensureDir(target);
      await ensureDir(target);
      expect((await stat(target)).isDirectory()).toBe(true);
    });
  });
});

describe('atomicWriteText', () => {
  test('writes content, creating the parent directory', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, 'nested', 'out.txt');
      await atomicWriteText(target, 'hello');
      expect(await readFile(target, 'utf8')).toBe('hello');
    });
  });

  test('replaces an existing file and leaves no temp files behind', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, 'out.txt');
      await atomicWriteText(target, 'first');
      await atomicWriteText(target, 'second');
      expect(await readFile(target, 'utf8')).toBe('second');
      expect(await readdir(dir)).toEqual(['out.txt']);
    });
  });

  test('propagates the failure and cleans up its temp file when rename cannot land', async () => {
    await withTempDir(async (dir) => {
      // target's parent is a FILE, so the temp write itself fails → error surfaces.
      await writeFile(join(dir, 'blocker'), '');
      const target = join(dir, 'blocker', 'out.txt');
      await expect(atomicWriteText(target, 'x')).rejects.toThrow();
      expect(await readdir(dir)).toEqual(['blocker']);
    });
  });
});

const sample = z.object({ name: z.string(), count: z.number() }).strict();

describe('readJson', () => {
  test('parses and validates a schema-conforming file', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'ok.json');
      await writeFile(path, JSON.stringify({ name: 'a', count: 1 }));
      expect(await readJson(path, sample)).toEqual({ name: 'a', count: 1 });
    });
  });

  test('throws SchemaValidationError on malformed JSON text', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'bad.json');
      await writeFile(path, '{not json');
      await expect(readJson(path, sample)).rejects.toBeInstanceOf(
        SchemaValidationError,
      );
    });
  });

  test('throws SchemaValidationError carrying the path on schema mismatch', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'mismatch.json');
      await writeFile(path, JSON.stringify({ name: 'a' }));
      const err = await readJson(path, sample).catch((e) => e);
      expect(err).toBeInstanceOf(SchemaValidationError);
      expect((err as SchemaValidationError).path).toBe(path);
    });
  });
});

describe('writeJson', () => {
  test('validates then writes pretty JSON with a trailing newline', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'out.json');
      const written = await writeJson(path, sample, { name: 'a', count: 2 });
      expect(written).toEqual({ name: 'a', count: 2 });
      const text = await readFile(path, 'utf8');
      expect(text).toBe(`${JSON.stringify({ name: 'a', count: 2 }, null, 2)}\n`);
    });
  });

  test('rejects an invalid value BEFORE touching the file', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'out.json');
      await expect(
        writeJson(path, sample, { name: 'a' } as z.input<typeof sample>),
      ).rejects.toBeInstanceOf(SchemaValidationError);
      expect(await readdir(dir)).toEqual([]);
    });
  });
});

// A homeDir unrelated to the temp tree, so the walk-up cap never triggers unless
// a test injects one on purpose.
const UNRELATED_HOME = '/nonexistent-home-for-rebuild-fs-tests';

describe('findRepoRoot', () => {
  test('returns the nearest directory containing .ditto', async () => {
    await withTempDir(async (dir) => {
      await ensureDir(join(dir, 'repo', '.ditto'));
      const start = join(dir, 'repo', 'a', 'b');
      await ensureDir(start);
      expect(await findRepoRoot(start, UNRELATED_HOME)).toBe(join(dir, 'repo'));
    });
  });

  test('prefers a .ditto ancestor over a NEARER .git ancestor', async () => {
    await withTempDir(async (dir) => {
      await ensureDir(join(dir, 'outer', '.ditto'));
      await ensureDir(join(dir, 'outer', 'inner', '.git'));
      const start = join(dir, 'outer', 'inner', 'deep');
      await ensureDir(start);
      expect(await findRepoRoot(start, UNRELATED_HOME)).toBe(join(dir, 'outer'));
    });
  });

  test('falls back to the nearest .git directory when no .ditto exists', async () => {
    await withTempDir(async (dir) => {
      await ensureDir(join(dir, 'repo', '.git'));
      const start = join(dir, 'repo', 'src');
      await ensureDir(start);
      expect(await findRepoRoot(start, UNRELATED_HOME)).toBe(join(dir, 'repo'));
    });
  });

  test('throws RepoRootNotFoundError when neither marker exists', async () => {
    await withTempDir(async (dir) => {
      const start = join(dir, 'plain');
      await ensureDir(start);
      await expect(findRepoRoot(start, UNRELATED_HOME)).rejects.toBeInstanceOf(
        RepoRootNotFoundError,
      );
    });
  });

  test('never matches a marker at $HOME itself (walk-up cap)', async () => {
    await withTempDir(async (dir) => {
      // dir plays the role of $HOME and carries a stray .ditto — it must be ignored.
      await ensureDir(join(dir, '.ditto'));
      const start = join(dir, 'work');
      await ensureDir(start);
      await expect(findRepoRoot(start, dir)).rejects.toBeInstanceOf(
        RepoRootNotFoundError,
      );
    });
  });

  test('still finds a marker strictly below $HOME', async () => {
    await withTempDir(async (dir) => {
      await ensureDir(join(dir, 'repo', '.ditto'));
      const start = join(dir, 'repo', 'sub');
      await ensureDir(start);
      expect(await findRepoRoot(start, dir)).toBe(join(dir, 'repo'));
    });
  });
});
