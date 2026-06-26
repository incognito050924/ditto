import { randomBytes } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import type { ZodTypeAny, z } from 'zod';
import { fileExists, parseYaml } from './hosts/shared';
import { parseWorktreePath } from './worktree';

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

/**
 * Walk upward from `start` until a directory containing `.ditto` is found.
 * If none exists, fall back to the nearest directory containing `.git`.
 * If neither exists, throw — callers that want to create a new repo root
 * must handle that explicitly via `resolveRepoRootForCreate`.
 *
 * The walk-up is CAPPED at `$HOME` (ADR-0011 session-rooting invariant,
 * wi_260625x74 ac-2): the home directory and any ancestor of it are never
 * matched, so a stray `~/.git` or `~/.ditto` cannot widen the session root to
 * the whole home tree. When no marker exists strictly below `$HOME` this throws,
 * and `resolveRepoRootForCreate` then falls back to the caller's cwd. `homeDir`
 * is injectable for testing; it defaults to the real home directory.
 */
/**
 * True when `current` is `$HOME` itself or one of its ancestors — the walk-up cap
 * stops there so rooting never escapes the workspace up into the home tree. `rel` is
 * `relative(current, home)`: it has no leading `..` exactly when `current` is at/above
 * home. The ABSOLUTE check guards the Windows cross-drive case (wi_260625x74 n4): when
 * the repo is on `D:` and home on `C:`, `relative()` cannot relativize across drives
 * and returns an absolute path — that means home is UNRELATED to `current`, not above
 * it, so we must NOT stop. `isAbs` is injectable so this is testable per-platform.
 */
export function isAtOrAboveHome(rel: string, isAbs: (p: string) => boolean = isAbsolute): boolean {
  return rel === '' || (!rel.startsWith('..') && !isAbs(rel));
}

export async function findRepoRoot(
  start: string = process.cwd(),
  homeDir: string = homedir(),
): Promise<string> {
  const resolved = resolve(start);
  // wi_260626zzx ac-1: a session opened inside a per-work-item worktree
  // (`<ws>/.ditto/local/worktrees/<wi>/…`) must root at the OWNING workspace `<ws>`,
  // not at the worktree's own checked-out `.ditto`. Detected by path segment BEFORE
  // the walk-up, so the worktree's tracked `.ditto/knowledge` can never capture the
  // root. Non-worktree paths return null here and fall through unchanged (no regression).
  const worktree = parseWorktreePath(resolved);
  if (worktree !== null) return worktree.workspace;
  let current = resolved;
  let firstGitMatch: string | null = null;
  const root = parse(current).root;
  const home = resolve(homeDir);
  while (true) {
    if (isAtOrAboveHome(relative(current, home))) break;
    if (await fileExists(join(current, '.ditto'))) return current;
    if (firstGitMatch === null && (await fileExists(join(current, '.git')))) {
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
export async function resolveRepoRootForCreate(
  start: string = process.cwd(),
  homeDir: string = homedir(),
): Promise<string> {
  try {
    return await findRepoRoot(start, homeDir);
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
    if (await fileExists(tmp)) {
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
