import { randomBytes } from 'node:crypto';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
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
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk upward from `start` until a directory containing `.ditto` is found.
 * If none exists, fall back to the nearest directory containing `.git`.
 * If neither exists, throw — callers that want to create a new repo root
 * must handle that explicitly via `resolveRepoRootForCreate`.
 */
export async function findRepoRoot(start: string = process.cwd()): Promise<string> {
  const resolved = resolve(start);
  let current = resolved;
  let firstGitMatch: string | null = null;
  const root = parse(current).root;
  while (true) {
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

/**
 * Choose where a new `.ditto/` should live. Prefer the nearest `.git` root
 * so DITTO state co-locates with the project. If neither `.ditto` nor `.git`
 * exists upward, use the caller's cwd.
 */
export async function resolveRepoRootForCreate(start: string = process.cwd()): Promise<string> {
  try {
    return await findRepoRoot(start);
  } catch {
    return resolve(start);
  }
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
    if (await pathExists(tmp)) {
      try {
        await unlink(tmp);
      } catch {
        // best effort cleanup
      }
    }
    throw err;
  }
}

export async function readJson<S extends ZodTypeAny>(
  path: string,
  schema: S,
): Promise<z.output<S>> {
  const file = Bun.file(path);
  const text = await file.text();
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
