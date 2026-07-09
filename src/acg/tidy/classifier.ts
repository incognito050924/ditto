/**
 * ⓪ Tidy entry classifier (80-plan §3, WU-1) — decide whether a just-made change
 * needs a Tidy pass. DETERMINISTIC diff-stat heuristic ONLY: code-touch + size /
 * file-count thresholds.
 *
 * Slop detection is deliberately NOT an ENTER condition (dialectic-8 OBJ-08):
 * slop precision (CodeQL fitness, §5(b)) runs in ③ tidy plan, AFTER ENTER. That
 * breaks the circularity of deciding "should we run CodeQL" from "the slop signal
 * CodeQL must produce". The classifier is a surface heuristic (diff stat), not a
 * call-graph inference, so it stays outside ADR-0006 D2's "no LLM structural
 * inference" scope.
 */
import { join } from 'node:path';
import { localDir } from '~/core/ditto-paths';
import { ensureDir, writeJson } from '~/core/fs';
import { type TidyClassification, tidyClassification } from '~/schemas/acg-tidy';

export interface TidyDiffFile {
  path: string;
  added: number;
  removed: number;
  /** True for source files (not docs/config); see {@link isCodePath}. */
  isCode: boolean;
}

export interface TidyDiffStat {
  files: TidyDiffFile[];
}

export interface TidyEntryThresholds {
  minCodeLines: number;
  minCodeFiles: number;
}

/**
 * Conservative defaults (PM-12): start high so small changes SKIP and the
 * classifier is not over-eager; tune down via dogfood measurement.
 */
export const DEFAULT_TIDY_THRESHOLDS: TidyEntryThresholds = {
  minCodeLines: 20,
  minCodeFiles: 3,
};

/** Source-file extensions; everything else (md/json/yaml/txt/...) is non-code. */
const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.cs',
  '.swift',
]);

/** Classify a repo-relative path as code by extension (diff-stat only). */
export function isCodePath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return CODE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/**
 * Deterministic ENTER/SKIP from diff-stat. Pure: no I/O, no slop, no provider.
 * SKIP when no code is touched, or when the code diff is below BOTH thresholds.
 * ENTER otherwise.
 */
export function classifyTidyEntry(
  stat: TidyDiffStat,
  thresholds: TidyEntryThresholds = DEFAULT_TIDY_THRESHOLDS,
): TidyClassification {
  const codeFilesArr = stat.files.filter((f) => f.isCode);
  const codeFiles = codeFilesArr.length;
  const codeLines = codeFilesArr.reduce((n, f) => n + f.added + f.removed, 0);

  if (codeFiles === 0) {
    return {
      decision: 'SKIP',
      reason: 'no code files touched (docs/config only)',
      codeFiles,
      codeLines,
    };
  }
  if (codeLines < thresholds.minCodeLines && codeFiles < thresholds.minCodeFiles) {
    return {
      decision: 'SKIP',
      reason: `code diff below threshold (${codeLines} lines < ${thresholds.minCodeLines} and ${codeFiles} files < ${thresholds.minCodeFiles})`,
      codeFiles,
      codeLines,
    };
  }
  return {
    decision: 'ENTER',
    reason: `code touched and diff-stat over threshold (${codeLines} lines, ${codeFiles} files)`,
    codeFiles,
    codeLines,
  };
}

/**
 * Persist the classifier verdict to
 * `.ditto/local/work-items/<wi>/tidy-classification.json` (ac-4: the decision is
 * left as an artifact). Returns the written path.
 */
export async function writeTidyClassification(
  repoRoot: string,
  workItemId: string,
  classification: TidyClassification,
): Promise<string> {
  const dir = localDir(repoRoot, 'work-items', workItemId);
  await ensureDir(dir);
  const path = join(dir, 'tidy-classification.json');
  await writeJson(path, tidyClassification, classification);
  return path;
}

/**
 * Collect a diff-stat from git (`git diff --numstat base...head`) and tag each
 * path as code/non-code. The git adapter for {@link classifyTidyEntry}.
 *
 * `pathspec` (optional) scopes the diff to the given repo-relative paths via a
 * trailing `-- <paths...>`. When it is non-empty the diff-stat contains ONLY those
 * paths, so a concurrent session's committed files (outside the scope) never enter
 * the stat and never spawn a spurious refactor node (wi_260709ft1). When it is
 * absent or empty the git args are byte-identical to the legacy unscoped diff.
 */
export function collectTidyDiffStat(
  repoRoot: string,
  base: string,
  head = 'HEAD',
  pathspec?: string[],
): TidyDiffStat {
  const scope = pathspec && pathspec.length > 0 ? ['--', ...pathspec] : [];
  const out = Bun.spawnSync(['git', 'diff', '--numstat', `${base}...${head}`, ...scope], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (out.exitCode !== 0) return { files: [] };
  const text = out.stdout?.toString() ?? '';
  const files: TidyDiffFile[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    // numstat: "<added>\t<removed>\t<path>"; binary files show "-" for counts.
    const [addedRaw, removedRaw, ...rest] = t.split('\t');
    const path = rest.join('\t');
    if (path.length === 0) continue;
    const added = addedRaw === '-' ? 0 : Number.parseInt(addedRaw, 10) || 0;
    const removed = removedRaw === '-' ? 0 : Number.parseInt(removedRaw, 10) || 0;
    files.push({ path, added, removed, isCode: isCodePath(path) });
  }
  return { files };
}
