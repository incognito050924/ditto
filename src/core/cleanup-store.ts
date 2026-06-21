import { mkdir, rename, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  type CleanupAction,
  type CleanupBasisSignal,
  type CleanupEntry,
  type CleanupIndex,
  type CleanupRunParams,
  cleanupAction,
  cleanupIndex,
} from '~/schemas/cleanup-index';
import { localDir } from './ditto-paths';
import { ensureDir, readJson, writeJson } from './fs';
import { findOwningRepo } from './memory-scan';

/** The four action subfolders created under every run folder. */
export const CLEANUP_ACTIONS = cleanupAction.options as readonly CleanupAction[];

/**
 * Inviolable protected set (ac-4). Any path under these prefixes — or matching
 * these filename patterns — can never be staged, regardless of caller or
 * aggressiveness. Enforced at the store layer so no caller can bypass it.
 */
const PROTECTED_DIR_PREFIXES = ['.ditto/knowledge', 'reports/design', 'reports/contracts'] as const;

/** Repo-relative filenames (basename) that are always protected. */
function isProtectedBasename(base: string): boolean {
  if (base === 'CLAUDE.md' || base === 'AGENTS.md') return true;
  if (/^README(\..+)?$/i.test(base)) return true;
  return false;
}

/**
 * True if `repoRelPath` (repo-relative, forward-slash) is in the protected set.
 * Used as a hard refusal predicate before any staging move.
 */
export function isProtectedPath(repoRelPath: string): boolean {
  const norm = repoRelPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const base = norm.split('/').pop() ?? norm;
  if (isProtectedBasename(base)) return true;
  for (const prefix of PROTECTED_DIR_PREFIXES) {
    if (norm === prefix || norm.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export class CleanupProtectedPathError extends Error {
  constructor(repoRelPath: string) {
    super(`refusing to stage protected path: ${repoRelPath}`);
    this.name = 'CleanupProtectedPathError';
  }
}

export class CleanupBasisRequiredError extends Error {
  constructor(repoRelPath: string) {
    super(`refusing to classify ${repoRelPath} with empty basis (>=1 signal required)`);
    this.name = 'CleanupBasisRequiredError';
  }
}

/** Local timestamp formatted as YYYYMMDD-HHMMSS for run ids. */
function runStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

function toRepoRel(repoRoot: string, absPath: string): string {
  return relative(repoRoot, absPath).replace(/\\/g, '/');
}

export interface StageDocInput {
  /** Absolute path of the doc to stage (must live under repoRoot). */
  absPath: string;
  /** Display name; defaults to the basename. */
  name?: string;
  action: CleanupAction;
  summary: string;
  basis: CleanupBasisSignal[];
  aggressiveness: number;
  agent?: string;
}

export class CleanupStore {
  constructor(public readonly repoRoot: string) {}

  /** Absolute path to a run folder. */
  runDir(runId: string): string {
    return localDir(this.repoRoot, 'cleanup', runId);
  }

  private indexPath(runId: string): string {
    return join(this.runDir(runId), 'index.json');
  }

  /**
   * Create a run folder with a collision-guarded auto id
   * `cleanup-<YYYYMMDD-HHMMSS>` plus the four action subfolders. Returns the
   * resolved run id (suffixed if a sub-second collision occurred). Writes an
   * initial index with zero entries.
   */
  async createRun(params: CleanupRunParams, now: Date = new Date()): Promise<string> {
    const stamp = runStamp(now);
    let runId = `cleanup-${stamp}`;
    let suffix = 0;
    // Parent (`.ditto/local/cleanup`) must exist before the non-recursive
    // leaf mkdir below; the leaf mkdir is the atomic per-run claim.
    await ensureDir(localDir(this.repoRoot, 'cleanup'));
    // Collision guard: mkdir is the atomic claim. Retry with a -<n> suffix
    // until a fresh folder is created so concurrent sub-second runs never
    // share a folder.
    while (true) {
      try {
        await mkdir(this.runDir(runId), { recursive: false });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        suffix += 1;
        runId = `cleanup-${stamp}-${suffix}`;
      }
    }
    for (const action of CLEANUP_ACTIONS) {
      await ensureDir(join(this.runDir(runId), action));
    }
    const index: CleanupIndex = {
      schema_version: '0.1.0',
      run_id: runId,
      created_at: now.toISOString(),
      workspace_root: resolve(this.repoRoot),
      params,
      entries: [],
    };
    await writeJson(this.indexPath(runId), cleanupIndex, index);
    return runId;
  }

  async readIndex(runId: string): Promise<CleanupIndex> {
    return readJson(this.indexPath(runId), cleanupIndex);
  }

  /**
   * Move one doc into its action subfolder and append a 1:1 index entry.
   *
   * Order is move-then-record: the fs rename happens first, then the entry is
   * persisted immediately (read-modify-write of index.json) so the on-disk
   * index always reflects what has actually moved — no batch write held in
   * memory (ac-2). Refuses protected paths (ac-4) and empty basis (ac-5)
   * BEFORE moving anything.
   */
  async stageDoc(runId: string, input: StageDocInput): Promise<CleanupEntry> {
    const abs = resolve(input.absPath);
    const repoRel = toRepoRel(this.repoRoot, abs);
    if (repoRel.startsWith('..') || isAbsolute(repoRel)) {
      throw new Error(`doc must live under repoRoot: ${input.absPath}`);
    }
    // ac-4: protected-set inviolability, enforced at the store layer.
    if (isProtectedPath(repoRel)) throw new CleanupProtectedPathError(repoRel);
    // ac-5: no classification without basis.
    if (input.basis.length === 0) throw new CleanupBasisRequiredError(repoRel);

    const name = input.name ?? repoRel.split('/').pop() ?? repoRel;
    // ac-7: resolve owning sub-repo via the shared scan helper.
    const owning = await findOwningRepo(abs, this.repoRoot);
    const owningRepo = owning === null ? null : toRepoRel(this.repoRoot, owning) || '.';

    const destAbs = join(this.runDir(runId), input.action, name);
    await ensureDir(join(this.runDir(runId), input.action));
    await rename(abs, destAbs);

    const entry: CleanupEntry = {
      name,
      original_path: repoRel,
      owning_repo: owningRepo,
      action: input.action,
      staged_path: toRepoRel(this.repoRoot, destAbs),
      summary: input.summary,
      basis: input.basis,
      audit: {
        classified_at: new Date().toISOString(),
        aggressiveness: input.aggressiveness,
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
      },
    };

    const index = await this.readIndex(runId);
    index.entries.push(entry);
    await writeJson(this.indexPath(runId), cleanupIndex, index);
    return entry;
  }

  /**
   * Restore primitive (ac-2): move a staged doc back to its original path.
   * Looks the entry up by original_path. Move-not-delete keeps it reversible.
   */
  async restore(runId: string, originalPath: string): Promise<CleanupEntry> {
    const index = await this.readIndex(runId);
    const entry = index.entries.find((e) => e.original_path === originalPath);
    if (entry === undefined) {
      throw new Error(`no staged entry for original_path: ${originalPath}`);
    }
    const stagedAbs = join(this.repoRoot, entry.staged_path);
    const originalAbs = join(this.repoRoot, entry.original_path);
    await ensureDir(join(originalAbs, '..'));
    await rename(stagedAbs, originalAbs);
    return entry;
  }

  async exists(runId: string): Promise<boolean> {
    try {
      await stat(this.runDir(runId));
      return true;
    } catch {
      return false;
    }
  }
}
