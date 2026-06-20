/**
 * `ditto classify scan` core — deterministic candidate discovery + lost-authority
 * signals for the doc-cleanup classify pipeline.
 *
 * Per ADR-0001, ditto (TypeScript) never calls an LLM. So this file computes ONLY
 * the DETERMINISTIC signals — `orphan` (no inbound reference found) and `stale`
 * (doc older than the most recent commit touching related code). The third signal,
 * `contradiction`, needs judgment and is the per-doc agent's job in the skill, not
 * here. The protected set (CleanupStore.isProtectedPath) is excluded from
 * candidates (ac-4). Owning sub-repo is resolved via findOwningRepo (ac-7).
 */
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isProtectedPath } from './cleanup-store';
import { findOwningRepo } from './memory-scan';

/** Directories never walked when discovering candidate docs (mirrors memory-scan). */
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

/** Document file extensions considered candidates for cleanup classification. */
const DOC_EXTS: ReadonlySet<string> = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);

export type CleanupTrackedFilter = 'tracked-only' | 'include-untracked' | 'untracked-only';

export interface ScanOptions {
  /** Which git-tracking status to include. */
  trackedFilter: CleanupTrackedFilter;
  /**
   * Optional scope: a gitignore-form glob limiting which repo-relative paths are
   * considered, OR a list of commit hashes whose touched docs define the scope.
   */
  scopeGlob?: string;
  scopeCommits?: string[];
  /** Doc categories in scope (advisory metadata, default all). */
  categories?: string[];
  /** 1 (conservative) … 5 (aggressive). Advisory to the per-doc agent. */
  aggressiveness: number;
}

export interface CandidateSignal {
  kind: 'orphan' | 'stale';
  detail: string;
}

export interface CandidateDoc {
  /** Repo-relative, forward-slash path. */
  path: string;
  /** Nearest owning sub-repo (repo-relative), or null for the workspace root. */
  owning_repo: string | null;
  /** Whether git tracks this path. */
  tracked: boolean;
  /** Deterministic lost-authority signals found (may be empty — agent decides). */
  signals: CandidateSignal[];
}

export interface ScanResult {
  candidates: CandidateDoc[];
  /** Repo-relative paths excluded because they are in the protected set (ac-4). */
  excluded_protected: string[];
}

function isDocFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return DOC_EXTS.has(name.slice(dot).toLowerCase());
}

async function walkDocs(root: string, maxDepth = 12): Promise<string[]> {
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
      } else if (e.isFile() && isDocFile(e.name)) {
        out.push(full);
      }
    }
  }
  await walk(resolve(root), 0);
  out.sort();
  return out;
}

/** Set of git-tracked repo-relative paths. Empty set on any git error. */
function trackedPaths(repoRoot: string): Set<string> {
  const proc = Bun.spawnSync(['git', 'ls-files'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return new Set();
  return new Set(
    (proc.stdout?.toString() ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
}

/** Docs touched by the given commit hashes (repo-relative). Empty on git error. */
function docsTouchedByCommits(repoRoot: string, commits: string[]): Set<string> {
  const out = new Set<string>();
  for (const c of commits) {
    const proc = Bun.spawnSync(['git', 'show', '--name-only', '--pretty=format:', c], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) continue;
    for (const l of (proc.stdout?.toString() ?? '').split('\n')) {
      const p = l.trim();
      if (p.length > 0) out.add(p);
    }
  }
  return out;
}

/** Author timestamp (ms) of the most recent commit touching `pathspec`, or null. */
function lastCommitTouchingMs(repoRoot: string, pathspec: string): number | null {
  const proc = Bun.spawnSync(['git', 'log', '-1', '--format=%ct', '--', pathspec], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return null;
  const secs = Number((proc.stdout?.toString() ?? '').trim());
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
}

/**
 * Inbound-reference check (orphan signal): grep the doc's basename across the
 * tracked corpus (code + docs + ADR + CLAUDE.md projection). A doc referenced
 * only by itself is an orphan. Deterministic — no judgment.
 */
function hasInboundReference(repoRoot: string, repoRel: string): boolean {
  const base = repoRel.split('/').pop() ?? repoRel;
  // Fixed-string grep for the basename across the whole tree, excluding the doc
  // itself. -F fixed string, -r recursive, -l names only, -I skip binary.
  const proc = Bun.spawnSync(['git', 'grep', '-F', '-l', '-I', '--', base], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return false; // no match (exit 1) or error → no inbound ref
  const hits = (proc.stdout?.toString() ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== repoRel);
  return hits.length > 0;
}

/**
 * Discover candidate docs across the workspace and attach deterministic signals.
 * Excludes the protected set (ac-4). Resolves each doc's owning sub-repo (ac-7).
 */
export async function scanCandidates(repoRoot: string, options: ScanOptions): Promise<ScanResult> {
  const root = resolve(repoRoot);
  const absFiles = await walkDocs(root);
  const tracked = trackedPaths(root);
  const scopeCommitDocs =
    options.scopeCommits && options.scopeCommits.length > 0
      ? docsTouchedByCommits(root, options.scopeCommits)
      : null;

  const candidates: CandidateDoc[] = [];
  const excludedProtected: string[] = [];

  for (const abs of absFiles) {
    const repoRel = relative(root, abs).replace(/\\/g, '/');
    if (repoRel.startsWith('..') || isAbsolute(repoRel)) continue;

    // ac-4: protected set is never a candidate.
    if (isProtectedPath(repoRel)) {
      excludedProtected.push(repoRel);
      continue;
    }

    const isTracked = tracked.has(repoRel);
    // tracked filter (ac-3)
    if (options.trackedFilter === 'tracked-only' && !isTracked) continue;
    if (options.trackedFilter === 'untracked-only' && isTracked) continue;

    // scope by glob (gitignore-form) limits which paths are in scope (ac-3)
    if (options.scopeGlob && !matchesGlob(repoRel, options.scopeGlob)) continue;
    // scope by commit list limits to docs those commits touched (ac-3)
    if (scopeCommitDocs && !scopeCommitDocs.has(repoRel)) continue;

    const owning = await findOwningRepo(abs, root);
    const owningRepo = owning === null ? null : relative(root, owning).replace(/\\/g, '/') || '.';

    const signals: CandidateSignal[] = [];
    // orphan: no inbound reference anywhere in the tree.
    if (!hasInboundReference(root, repoRel)) {
      signals.push({ kind: 'orphan', detail: `no inbound reference to ${repoRel}` });
    }
    // stale: doc mtime older than the most recent commit touching its OWN path
    // (a doc untouched while its own history kept moving is a drift candidate).
    const docMtimeMs = (await stat(abs)).mtimeMs;
    const lastCommitMs = lastCommitTouchingMs(root, repoRel);
    if (lastCommitMs !== null && docMtimeMs < lastCommitMs) {
      signals.push({
        kind: 'stale',
        detail: `doc mtime older than its most recent commit (${new Date(lastCommitMs).toISOString()})`,
      });
    }

    candidates.push({ path: repoRel, owning_repo: owningRepo, tracked: isTracked, signals });
  }

  return { candidates, excluded_protected: excludedProtected };
}

/**
 * Minimal gitignore-form glob match for the scope filter. Supports `*` (any run
 * within a segment), `**` (any run across segments), and `?`. Anchored to the
 * whole repo-relative path. Deterministic, dependency-free.
 */
export function matchesGlob(repoRel: string, glob: string): boolean {
  const re = globToRegExp(glob);
  return re.test(repoRel);
}

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c as string)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}
