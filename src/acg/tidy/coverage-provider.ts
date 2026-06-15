/**
 * ① L1 coverage provider (80-plan §4.3/§4.4/§14 Q3, wi_260615889) — the real
 * toolchain provider behind `behavior-lock.ts`'s `CoverageProvider` seam (which was
 * 0건 until now). It runs `bun test --coverage` (lcov reporter) once, parses the
 * per-file line coverage, and answers "is this changed region executed by the suite?".
 *
 * GRANULARITY: bun's lcov emits per-file line data (DA/LF/LH) and function COUNTS
 * (FNF/FNH) but no per-function names/ranges, so a region is decided at FILE level —
 * a file present in the lcov with linesHit>0 is executed by the characterization
 * suite. region.functions is therefore advisory only (no per-function lcov data).
 *
 * FAIL-OPEN (OBJ-02): collection failure / no coverage data → `buildCoverageProvider`
 * returns `undefined`, i.e. the provider is treated as ABSENT. assessBehaviorLock then
 * fails open to degraded/diff-only — never a hard block.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangedRegion, CoverageProvider, CoverageResult } from './behavior-lock';

/** Per-file line coverage extracted from one lcov `SF…end_of_record` block. */
export interface FileCoverage {
  linesFound: number;
  linesHit: number;
}

/** Repo-relative source path → its line coverage. */
export type CoverageMap = Map<string, FileCoverage>;

/** Normalize an lcov SF / region path to a comparable repo-relative key. */
function normalizePath(p: string): string {
  return p.trim().replace(/^\.\//, '');
}

/**
 * Parse bun lcov text into a per-file line-coverage map (pure). Only SF/LF/LH are
 * consumed; FN/BR/DA/TN lines are ignored (DA is summarized by LF/LH). A block
 * without an explicit LF/LH still records 0/0 for the file it names.
 */
export function parseLcov(lcov: string): CoverageMap {
  const map: CoverageMap = new Map();
  let file: string | null = null;
  let linesFound = 0;
  let linesHit = 0;
  for (const raw of lcov.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      file = normalizePath(line.slice(3));
      linesFound = 0;
      linesHit = 0;
    } else if (line.startsWith('LF:')) {
      linesFound = Number.parseInt(line.slice(3), 10) || 0;
    } else if (line.startsWith('LH:')) {
      linesHit = Number.parseInt(line.slice(3), 10) || 0;
    } else if (line === 'end_of_record' && file) {
      map.set(file, { linesFound, linesHit });
      file = null;
    }
  }
  return map;
}

/**
 * Decide whether a changed region is executed by the suite (pure). A region is
 * `covered` iff it names ≥1 file AND EVERY named file is present in the lcov with
 * linesHit>0 (each changed file is witnessed by at least one test). A file that is
 * absent (never loaded) or has linesHit==0 (loaded but never executed) leaves the
 * region unwitnessed → `uncovered`. coveredRatio is the aggregate hit/found over the
 * region's files (a region-level summary, not a per-file gate).
 */
export function regionCoverage(map: CoverageMap, region: ChangedRegion): CoverageResult {
  const files = region.files.map(normalizePath);
  if (files.length === 0) return { status: 'uncovered', coveredRatio: 0 };

  let found = 0;
  let hit = 0;
  let everyFileExecuted = true;
  for (const f of files) {
    const cov = map.get(f);
    if (!cov || cov.linesHit === 0) everyFileExecuted = false;
    if (cov) {
      found += cov.linesFound;
      hit += cov.linesHit;
    }
  }
  const coveredRatio = found > 0 ? hit / found : 0;
  return { status: everyFileExecuted ? 'covered' : 'uncovered', coveredRatio };
}

/** Outcome of one coverage collection — `ok:false` means "could not collect" (fail-open). */
export interface CoverageCollectResult {
  ok: boolean;
  lcov?: string;
  reason?: string;
}

/** The collection seam — injected in tests; the default shells out to `bun test`. */
export interface CoverageDeps {
  collect(repoRoot: string): CoverageCollectResult;
}

/**
 * Default collection: run `bun test --coverage` (lcov) into a throwaway dir and read
 * the lcov. Exit code is NOT authoritative — a failing test still emits coverage for the
 * files it executed, and baseline-green is a SEPARATE gate (behavior-lock.baselineGreen).
 * Absent lcov (no tests / bun missing / spawn failure) → ok:false → fail-open.
 */
function defaultCollect(repoRoot: string): CoverageCollectResult {
  let covDir: string;
  try {
    covDir = mkdtempSync(join(tmpdir(), 'ditto-cov-'));
  } catch (err) {
    return { ok: false, reason: `could not create coverage dir: ${String(err)}` };
  }
  try {
    Bun.spawnSync(
      ['bun', 'test', '--coverage', '--coverage-reporter=lcov', `--coverage-dir=${covDir}`],
      { cwd: repoRoot, stdout: 'ignore', stderr: 'ignore' },
    );
    try {
      return { ok: true, lcov: readFileSync(join(covDir, 'lcov.info'), 'utf8') };
    } catch {
      return { ok: false, reason: 'no lcov produced (no tests executed?)' };
    }
  } catch (err) {
    return { ok: false, reason: `coverage run failed: ${String(err)}` };
  } finally {
    rmSync(covDir, { recursive: true, force: true });
  }
}

/**
 * Build the L1 coverage provider for a repo. Collects coverage ONCE up front and caches
 * the parsed map, so the returned `coverageOf` answers many regions cheaply. Returns
 * `undefined` (provider ABSENT — fail-open, OBJ-02) when coverage cannot be collected or
 * yields no data; callers then degrade to diff-only rather than hard-block.
 */
export function buildCoverageProvider(
  repoRoot: string,
  deps: CoverageDeps = { collect: defaultCollect },
): CoverageProvider | undefined {
  const res = deps.collect(repoRoot);
  if (!res.ok || !res.lcov) return undefined;
  const map = parseLcov(res.lcov);
  if (map.size === 0) return undefined;
  return { coverageOf: (region) => regionCoverage(map, region) };
}
