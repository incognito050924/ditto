import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import type { ZodTypeAny, z } from 'zod';

export class RepoRootNotFoundError extends Error {
  constructor(start: string) {
    super(`No .ditto or .git found from ${start} upward; cannot determine repo root`);
    this.name = 'RepoRootNotFoundError';
  }
}

export class SchemaValidationError extends Error {
  public readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`schema validation failed for ${path}: ${String(cause)}`, { cause });
    this.name = 'SchemaValidationError';
    this.path = path;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * True when `current` is `$HOME` itself or one of its ancestors — the walk-up cap
 * stops there so rooting never escapes the workspace up into the home tree. `rel` is
 * `relative(current, home)`: it has no leading `..` exactly when `current` is at/above
 * home. The absolute check guards the Windows cross-drive case: when the repo and home
 * sit on different drives, `relative()` cannot relativize and returns an absolute path —
 * home is then UNRELATED to `current`, not above it, so the cap must NOT stop the walk.
 */
function isAtOrAboveHome(rel: string): boolean {
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Walk upward from `start` until a directory containing `.ditto` is found.
 * If none exists, fall back to the NEAREST directory containing `.git`.
 * If neither exists, throw RepoRootNotFoundError.
 *
 * The walk-up is CAPPED at `$HOME`: the home directory and any ancestor of it are
 * never matched, so a stray `~/.git` or `~/.ditto` cannot widen the repo root to
 * the whole home tree. `homeDir` is injectable for testing; it defaults to the
 * real home directory.
 */
export async function findRepoRoot(
  start: string = process.cwd(),
  homeDir: string = homedir(),
): Promise<string> {
  const resolved = resolve(start);
  let current = resolved;
  let firstGitMatch: string | null = null;
  const root = parse(current).root;
  const home = resolve(homeDir);
  while (true) {
    if (isAtOrAboveHome(relative(current, home))) break;
    if (await pathExists(join(current, '.ditto'))) return current;
    if (firstGitMatch === null && (await pathExists(join(current, '.git')))) {
      firstGitMatch = current;
    }
    if (current === root) break;
    current = dirname(current);
  }
  if (firstGitMatch !== null) return firstGitMatch;
  throw new RepoRootNotFoundError(resolved);
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Write `content` to `path` atomically: write to a sibling temp file and rename.
 * Crashes mid-write leave the temp file but never a half-written target.
 */
export async function atomicWriteText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const suffix = randomBytes(6).toString('hex');
  const tmp = `${path}.${process.pid}.${suffix}.tmp`;
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {
      // best effort cleanup — the temp file may never have been created
    });
    throw err;
  }
}

export async function readJson<S extends ZodTypeAny>(
  path: string,
  schema: S,
): Promise<z.output<S>> {
  const text = await readFile(path, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SchemaValidationError(path, err);
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw new SchemaValidationError(path, result.error);
  return result.data;
}

/** Validate-then-write: an invalid value never touches the file (atomic write). */
export async function writeJson<S extends ZodTypeAny>(
  path: string,
  schema: S,
  value: z.input<S>,
): Promise<z.output<S>> {
  const result = schema.safeParse(value);
  if (!result.success) throw new SchemaValidationError(path, result.error);
  await atomicWriteText(path, `${JSON.stringify(result.data, null, 2)}\n`);
  return result.data;
}
