import { randomBytes } from 'node:crypto';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, parse, resolve } from 'node:path';
import type { ZodTypeAny, z } from 'zod';
import { parseYaml } from './hosts/shared';

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

/**
 * ArchitectureSpec 본문을 파싱한다 — 확장자로 형식 분기.
 * `.yaml`/`.yml`이면 YAML, 그 외(기존 `.json` 포함)는 JSON.parse.
 * 스키마 검증은 호출부에서 `acgArchitectureSpec`으로 한다(스키마 불변).
 */
export function parseArchitectureSpecText(text: string, path: string): unknown {
  const ext = extname(path).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') return parseYaml(text);
  return JSON.parse(text);
}

/** 확장자 분기로 ArchitectureSpec을 읽어 `schema`로 검증한다. */
export async function readArchitectureSpec<S extends ZodTypeAny>(
  path: string,
  schema: S,
): Promise<z.output<S>> {
  const text = await Bun.file(path).text();
  return schema.parse(parseArchitectureSpecText(text, path));
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
