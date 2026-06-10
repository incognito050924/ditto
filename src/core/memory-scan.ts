/**
 * `ditto memory scan` core (increment #2) — design §10-3 (scan row), §3-7.
 *
 * Walks a source root, hashes each code/document file into a MemorySource
 * manifest entry, resolves each source's OWNING repo, and records the owning
 * repo's HEAD as `revision`. Change detection is by content_hash against the
 * existing manifest. Pure policy lives in helpers; IO is the store + git.
 *
 * Owning-repo attribution (§3-7 / §10-1 F4): the nearest `.git` ancestor of a
 * source path is its repo. When that equals the scan repoRoot (the common
 * single-repo case) `repo` is OMITTED and `revision` is the repoRoot HEAD —
 * cost 0. In a multi-repo workspace where a source lives under a sub-repo that
 * differs from the rooting root, `repo` is the rooting-root-relative path to
 * that sub-repo and `revision`/`git_commit` are that sub-repo's HEAD.
 */
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { MemorySource } from '~/schemas/memory-source';
import { fileExists } from './hosts/shared';
import { MemorySourceStore, sha256Hex } from './memory-store';

/** Directories never scanned as memory sources (build output, VCS, deps, runtime state). */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.ditto',
  'target',
  'build',
  'dist',
  '.gradle',
  'out',
  'coverage',
]);

/** Extension → source_type. Only these file kinds are captured (code + docs). */
const EXT_TYPE: ReadonlyMap<string, MemorySource['source_type']> = new Map([
  ['.ts', 'code'],
  ['.tsx', 'code'],
  ['.js', 'code'],
  ['.jsx', 'code'],
  ['.mjs', 'code'],
  ['.cjs', 'code'],
  ['.py', 'code'],
  ['.java', 'code'],
  ['.kt', 'code'],
  ['.go', 'code'],
  ['.rs', 'code'],
  ['.md', 'markdown'],
  ['.mdx', 'markdown'],
]);

function classifyType(name: string): MemorySource['source_type'] | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXT_TYPE.get(name.slice(dot).toLowerCase());
}

/** Stable, path-derived source id: `src_<12 hex of sha256(repo-relative path)>`. */
export function sourceIdForPath(repoRelativePath: string): string {
  return `src_${sha256Hex(repoRelativePath).slice(0, 12)}`;
}

/** Best-effort HEAD sha for a git work tree; null if not git or git missing. */
function gitHeadSha(repoRoot: string): string | null {
  const proc = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return null;
  const sha = (proc.stdout?.toString() ?? '').trim();
  return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

/**
 * Nearest `.git` ancestor directory of `absPath`, bounded by `rootingRoot`.
 * Returns the absolute repo dir, or null if none up to (and including) the
 * rooting root. Walks parents so a file under a sub-repo resolves to that
 * sub-repo rather than the workspace.
 */
async function findOwningRepo(absPath: string, rootingRoot: string): Promise<string | null> {
  let current = resolve(absPath);
  const root = resolve(rootingRoot);
  while (true) {
    if (await fileExists(join(current, '.git'))) return current;
    if (current === root) return null;
    const parent = resolve(current, '..');
    if (parent === current) return null;
    // Do not climb above the rooting root.
    if (!resolve(current).startsWith(root + sep) && resolve(current) !== root) return null;
    current = parent;
  }
}

export interface ScannedSource {
  source: MemorySource;
  /** 'added' (new id), 'changed' (hash differs), 'unchanged'. */
  status: 'added' | 'changed' | 'unchanged';
}

export interface ScanResult {
  scanned: ScannedSource[];
  added: string[];
  changed: string[];
  unchanged: string[];
}

async function walkFiles(root: string, maxDepth = 12): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as unknown as Dirent[];
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full, depth + 1);
      } else if (e.isFile() && classifyType(e.name) !== undefined) {
        out.push(full);
      }
    }
  }
  await walk(resolve(root), 0);
  out.sort();
  return out;
}

/**
 * Scan `sourceRoot` (default repoRoot) into MemorySource manifest entries,
 * persisting them via the store, and report added/changed/unchanged.
 *
 * `repoRoot` is the rooting root (§3-7) and the SoT location. `sourceRoot` is
 * what to walk (defaults to repoRoot). Both must be absolute or are resolved.
 */
export async function scanSources(
  repoRoot: string,
  options: { sourceRoot?: string; now?: Date } = {},
): Promise<ScanResult> {
  const root = resolve(repoRoot);
  const sourceRoot = resolve(
    options.sourceRoot && isAbsolute(options.sourceRoot)
      ? options.sourceRoot
      : join(root, options.sourceRoot ?? '.'),
  );
  const now = (options.now ?? new Date()).toISOString();
  const store = new MemorySourceStore(root);
  const existing = new Map<string, MemorySource>();
  for (const s of await store.list()) existing.set(s.source_id, s);

  const files = await walkFiles(sourceRoot);
  // Cache HEAD per owning repo so we run git once per repo, not per file.
  const headCache = new Map<string, string | null>();
  const rootHead = gitHeadSha(root);
  headCache.set(root, rootHead);

  const scanned: ScannedSource[] = [];
  const added: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const abs of files) {
    const repoRelative = relative(root, abs);
    if (repoRelative.startsWith('..') || isAbsolute(repoRelative)) continue;
    const sourceType = classifyType(abs);
    if (sourceType === undefined) continue;
    const content = await Bun.file(abs).text();
    const contentHash = sha256Hex(content);
    const sourceId = sourceIdForPath(repoRelative);

    const owningRepo = await findOwningRepo(abs, root);
    const isOwnRoot = owningRepo === null || resolve(owningRepo) === root;
    let head: string | null;
    if (isOwnRoot) {
      head = rootHead;
    } else {
      const key = resolve(owningRepo as string);
      if (!headCache.has(key)) headCache.set(key, gitHeadSha(key));
      head = headCache.get(key) ?? null;
    }
    // revision: owning repo HEAD when git-tracked, else a content-snapshot marker.
    const revision = head ?? `snapshot:${contentHash.slice(0, 16)}`;

    const prior = existing.get(sourceId);
    const source: MemorySource = {
      schema_version: '0.1.0',
      source_id: sourceId,
      source_type: sourceType,
      path: repoRelative,
      content_hash: contentHash,
      captured_at: now,
      revision,
      // Automatic secret classification is follow-up; new sources default to
      // 'internal'. A rescan PRESERVES the prior record's sensitivity (R7) — the
      // secret gate (projection/build filters, F6) rides on this field, so a
      // content change must not silently reset a manual 'secret' marking.
      sensitivity: prior?.sensitivity ?? 'internal',
      word_count: content.split(/\s+/).filter((w) => w.length > 0).length,
      ...(isOwnRoot ? {} : { repo: relative(root, owningRepo as string) }),
      ...(head ? { git_commit: head } : {}),
    };

    let status: ScannedSource['status'];
    if (!prior) status = 'added';
    else if (prior.content_hash !== contentHash) status = 'changed';
    else status = 'unchanged';

    if (status === 'unchanged') {
      // Keep the existing entry untouched (no captured_at churn for clean files).
      scanned.push({ source: prior as MemorySource, status });
      unchanged.push(sourceId);
      continue;
    }
    await store.write(source);
    scanned.push({ source, status });
    if (status === 'added') added.push(sourceId);
    else changed.push(sourceId);
  }

  return { scanned, added, changed, unchanged };
}
