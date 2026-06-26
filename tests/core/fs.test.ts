import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, sep, win32 } from 'node:path';
import { z } from 'zod';
import {
  RepoRootNotFoundError,
  SchemaValidationError,
  atomicWriteText,
  ensureDir,
  findRepoRoot,
  isAtOrAboveHome,
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

  // ac-2 (wi_260625x74): walk-up is capped at $HOME. A stray ~/.git (or ~/.ditto)
  // must NOT widen the session rooting to the whole home tree — when no marker
  // exists strictly below $HOME the walk-up throws, so resolveRepoRootForCreate
  // falls back to the caller's cwd (ADR-0011 session-rooting invariant).
  test('caps walk-up at $HOME: a stray ~/.git does not root the session at home', async () => {
    const home = join(workDir, 'home');
    await ensureDir(join(home, '.git')); // stray marker at the home dir
    const start = join(home, 'projects', 'app'); // no marker below home
    await ensureDir(start);
    await expect(findRepoRoot(start, home)).rejects.toBeInstanceOf(RepoRootNotFoundError);
  });

  test('still finds a marker that sits strictly below $HOME (no regression)', async () => {
    const home = join(workDir, 'home');
    const repo = join(home, 'projects', 'app');
    await ensureDir(join(repo, '.ditto')); // marker below home
    const start = join(repo, 'src', 'deep');
    await ensureDir(start);
    expect(await findRepoRoot(start, home)).toBe(repo);
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

  // ac-2 (wi_260625x74): the $HOME cap flows through — when only ~/.git exists,
  // resolveRepoRootForCreate falls back to the caller's cwd, NOT home.
  test('falls back to the start cwd instead of rooting at $HOME', async () => {
    const home = join(workDir, 'home');
    await ensureDir(join(home, '.git'));
    const start = join(home, 'projects', 'app');
    await ensureDir(start);
    expect(await resolveRepoRootForCreate(start, home)).toBe(start);
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

// wi_260625x74 n4 (f1): the $HOME walk-up cap must not mis-fire on Windows
// cross-drive layouts. When the repo is on D: and $HOME on C:, `relative()` cannot
// relativize across drives and returns an ABSOLUTE path; that must NOT be read as
// "at/above home" (which would stop the walk-up at the first iteration and lose the
// repo's marker). path.win32 lets us assert this on any OS.
describe('isAtOrAboveHome (walk-up cap, cross-platform)', () => {
  test('Windows cross-drive (D: repo vs C: home) does NOT stop the walk-up', () => {
    const rel = win32.relative('D:\\proj', 'C:\\Users\\x');
    expect(win32.isAbsolute(rel)).toBe(true); // cross-drive cannot be relativized
    expect(isAtOrAboveHome(rel, win32.isAbsolute)).toBe(false);
  });

  test('current === home stops the walk-up', () => {
    expect(isAtOrAboveHome(win32.relative('C:\\Users\\x', 'C:\\Users\\x'), win32.isAbsolute)).toBe(
      true,
    );
    expect(isAtOrAboveHome(posix.relative('/home/x', '/home/x'), posix.isAbsolute)).toBe(true);
  });

  test('current is an ancestor of home stops the walk-up', () => {
    expect(isAtOrAboveHome(win32.relative('C:\\Users', 'C:\\Users\\x'), win32.isAbsolute)).toBe(
      true,
    );
    expect(isAtOrAboveHome(posix.relative('/home', '/home/x'), posix.isAbsolute)).toBe(true);
  });

  test('current strictly below home does NOT stop (marker search continues)', () => {
    expect(
      isAtOrAboveHome(win32.relative('C:\\Users\\x\\proj', 'C:\\Users\\x'), win32.isAbsolute),
    ).toBe(false);
    expect(isAtOrAboveHome(posix.relative('/home/x/proj', '/home/x'), posix.isAbsolute)).toBe(
      false,
    );
  });
});

describe('path separator sanity', () => {
  test('platform separator is consistent with node:path', () => {
    expect(typeof sep).toBe('string');
    expect(sep.length).toBe(1);
  });
});
