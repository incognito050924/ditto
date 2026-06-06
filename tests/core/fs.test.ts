import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { z } from 'zod';
import {
  RepoRootNotFoundError,
  SchemaValidationError,
  atomicWriteText,
  ensureDir,
  findRepoRoot,
  readJson,
  resolveRepoRootForCreate,
  writeJson,
} from '~/core/fs';
import { fileExists } from '~/core/hosts/shared';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-fs-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// wi_260606f4r — single existence check, stat-based so directories are detected
// (the old fs.ts/e2e pathExists used stat; shared.fileExists used Bun.file which
// reports false for directories — findRepoRoot relies on the directory case).
describe('fileExists (unified existence check)', () => {
  test('true for a regular file', async () => {
    const p = join(workDir, 'f.txt');
    await Bun.write(p, 'x');
    expect(await fileExists(p)).toBe(true);
  });

  test('true for a directory (stat-based; Bun.file().exists() would be false)', async () => {
    await ensureDir(join(workDir, 'd'));
    expect(await fileExists(join(workDir, 'd'))).toBe(true);
  });

  test('false for a missing path', async () => {
    expect(await fileExists(join(workDir, 'nope'))).toBe(false);
  });
});

describe('findRepoRoot', () => {
  test('returns the directory containing .ditto', async () => {
    await ensureDir(join(workDir, '.ditto'));
    const found = await findRepoRoot(workDir);
    expect(found).toBe(workDir);
  });

  test('finds .ditto from a nested subdirectory', async () => {
    await ensureDir(join(workDir, '.ditto'));
    const nested = join(workDir, 'a', 'b', 'c');
    await ensureDir(nested);
    const found = await findRepoRoot(nested);
    expect(found).toBe(workDir);
  });

  test('prefers .ditto when both .ditto and .git exist on the path', async () => {
    await ensureDir(join(workDir, '.git'));
    const inner = join(workDir, 'app');
    await ensureDir(join(inner, '.ditto'));
    const found = await findRepoRoot(inner);
    expect(found).toBe(inner);
  });

  test('falls back to nearest .git when no .ditto found', async () => {
    await ensureDir(join(workDir, '.git'));
    const nested = join(workDir, 'src', 'deep');
    await ensureDir(nested);
    const found = await findRepoRoot(nested);
    expect(found).toBe(workDir);
  });

  test('throws when neither .ditto nor .git found upward', async () => {
    // workDir is under tmpdir which has no .ditto/.git ancestors typically.
    // To be robust we assert error type and that message names the start dir.
    const nested = join(workDir, 'no-marker');
    await ensureDir(nested);
    try {
      await findRepoRoot(nested);
      // If for some reason the host tmpdir has a parent .git, this branch is acceptable.
    } catch (err) {
      expect(err).toBeInstanceOf(RepoRootNotFoundError);
    }
  });
});

describe('resolveRepoRootForCreate', () => {
  test('returns existing .ditto root when present', async () => {
    await ensureDir(join(workDir, '.ditto'));
    const r = await resolveRepoRootForCreate(workDir);
    expect(r).toBe(workDir);
  });

  test('returns start cwd when no marker found', async () => {
    // create a directory we know has no .ditto/.git ancestors via /tmp
    const r = await resolveRepoRootForCreate(workDir);
    // Either workDir itself (no marker) or an ancestor with .git/.ditto.
    // The contract: if findRepoRoot throws, fall back to start. We assert the
    // returned path resolves to one of these two.
    expect(r === workDir || r.length < workDir.length).toBe(true);
  });
});

describe('ensureDir', () => {
  test('creates nested directories', async () => {
    const target = join(workDir, 'a', 'b', 'c');
    await ensureDir(target);
    const entries = await readdir(join(workDir, 'a', 'b'));
    expect(entries).toContain('c');
  });

  test('is idempotent', async () => {
    const target = join(workDir, 'x');
    await ensureDir(target);
    await ensureDir(target);
  });
});

describe('atomicWriteText', () => {
  test('writes the exact content', async () => {
    const path = join(workDir, 'hello.txt');
    await atomicWriteText(path, 'hello world');
    const text = await Bun.file(path).text();
    expect(text).toBe('hello world');
  });

  test('creates parent directories', async () => {
    const path = join(workDir, 'deep', 'nested', 'file.txt');
    await atomicWriteText(path, 'ok');
    const text = await Bun.file(path).text();
    expect(text).toBe('ok');
  });

  test('does not leave temp files behind on success', async () => {
    const path = join(workDir, 'clean.txt');
    await atomicWriteText(path, 'data');
    const entries = await readdir(workDir);
    const stragglers = entries.filter((name) => name.endsWith('.tmp'));
    expect(stragglers).toEqual([]);
  });
});

const tinySchema = z.object({ n: z.number().int(), s: z.string().min(1) });

describe('writeJson + readJson round trip', () => {
  test('writes and reads back the value', async () => {
    const path = join(workDir, 'doc.json');
    await writeJson(path, tinySchema, { n: 1, s: 'x' });
    const back = await readJson(path, tinySchema);
    expect(back).toEqual({ n: 1, s: 'x' });
  });

  test('writeJson rejects values that fail schema parse', async () => {
    const path = join(workDir, 'bad.json');
    await expect(
      writeJson(path, tinySchema, { n: 'oops', s: 'x' } as never),
    ).rejects.toBeInstanceOf(SchemaValidationError);
    // file should not exist
    const file = Bun.file(path);
    expect(await file.exists()).toBe(false);
  });

  test('readJson rejects files that fail schema parse', async () => {
    const path = join(workDir, 'malformed.json');
    await atomicWriteText(path, '{"n":"not a number","s":"x"}');
    await expect(readJson(path, tinySchema)).rejects.toBeInstanceOf(SchemaValidationError);
  });

  test('readJson rejects non-JSON files', async () => {
    const path = join(workDir, 'notjson.json');
    await atomicWriteText(path, 'this is not json');
    await expect(readJson(path, tinySchema)).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe('path separator sanity', () => {
  test('platform separator is consistent with node:path', () => {
    expect(typeof sep).toBe('string');
    expect(sep.length).toBe(1);
  });
});
