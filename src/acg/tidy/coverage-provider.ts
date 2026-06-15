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
 * Default per-file line-coverage bar for "the changed region is witnessed" (item 3,
 * wi_260615q77). Replaces the earlier "any execution (>0)" rule, which over-credited a
 * file whose changed function was never hit but whose other lines ran. 0.8 = a file must
 * be substantially executed to count. bun lcov has no per-function data and ADR-0006
 * forbids the TS AST, so a per-file ratio is the finest gate available without a new ADR.
 */
export const DEFAULT_COVERAGE_THRESHOLD = 0.8;

/**
 * Decide whether a changed region is witnessed by the suite (pure). A region is
 * `covered` iff it names ≥1 file AND EVERY named file's per-file coveredRatio (linesHit /
 * linesFound) is >= `threshold`. A file absent from the lcov (never loaded), with 0 hits,
 * or executed only below the threshold leaves the region under-witnessed → `uncovered`.
 * The returned coveredRatio is the aggregate hit/found over the region's files (a summary;
 * the gate itself is per-file so one weak file cannot be masked by a strong one).
 */
export function regionCoverage(
  map: CoverageMap,
  region: ChangedRegion,
  threshold: number = DEFAULT_COVERAGE_THRESHOLD,
): CoverageResult {
  const files = region.files.map(normalizePath);
  if (files.length === 0) return { status: 'uncovered', coveredRatio: 0 };

  let found = 0;
  let hit = 0;
  let everyFileMeetsThreshold = true;
  for (const f of files) {
    const cov = map.get(f);
    const fileFound = cov?.linesFound ?? 0;
    const fileHit = cov?.linesHit ?? 0;
    const fileRatio = fileFound > 0 ? fileHit / fileFound : 0;
    if (fileRatio < threshold) everyFileMeetsThreshold = false;
    found += fileFound;
    hit += fileHit;
  }
  const coveredRatio = found > 0 ? hit / found : 0;
  return { status: everyFileMeetsThreshold ? 'covered' : 'uncovered', coveredRatio };
}

/** Basename of a path without its final extension: `src/acg/tidy/behavior-lock.ts` → `behavior-lock`. */
function basenameNoExt(p: string): string {
  const base = normalizePath(p).split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Map a unit's source files to the test files likely to exercise them (item 2, pure
 * heuristic). A test file matches a source file when the source's basename (no ext) is a
 * substring of the test path — this repo names tests after the source they cover, often
 * with the dir flattened (`src/acg/tidy/behavior-lock.ts` ↔ `tests/acg/tidy-behavior-lock.test.ts`).
 * Returns the deduped union. An empty result means "no mirror found" — the caller then
 * runs the full suite, and a scoped miss is caught by the full-suite escalation in
 * `buildCoverageProvider`, so this heuristic can only SAVE cost, never wrongly uncover.
 */
export function deriveUnitTestPaths(
  unitFiles: readonly string[],
  testFiles: readonly string[],
): string[] {
  const bases = new Set<string>();
  for (const f of unitFiles) {
    const b = basenameNoExt(f);
    if (b) bases.add(b);
  }
  const out = new Set<string>();
  for (const t of testFiles) {
    const tn = normalizePath(t);
    for (const b of bases) {
      if (tn.includes(b)) {
        out.add(tn);
        break;
      }
    }
  }
  return [...out];
}

/** Outcome of one coverage collection — `ok:false` means "could not collect" (fail-open). */
export interface CoverageCollectResult {
  ok: boolean;
  lcov?: string;
  reason?: string;
}

/**
 * The collection seam — injected in tests; the default shells out to `bun test`.
 * `testPaths`, when given, scopes the run to those test files (item 2 cost reduction);
 * omitted/empty → the whole suite.
 */
export interface CoverageDeps {
  collect(repoRoot: string, testPaths?: string[]): CoverageCollectResult;
}

/**
 * Default collection: run `bun test --coverage` (lcov) into a throwaway dir and read
 * the lcov. Exit code is NOT authoritative — a failing test still emits coverage for the
 * files it executed, and baseline-green is a SEPARATE gate (behavior-lock.baselineGreen).
 * `testPaths` scopes the run to specific test files; absent → the whole suite. Absent lcov
 * (no tests / bun missing / spawn failure) → ok:false → fail-open.
 */
function defaultCollect(repoRoot: string, testPaths?: string[]): CoverageCollectResult {
  let covDir: string;
  try {
    covDir = mkdtempSync(join(tmpdir(), 'ditto-cov-'));
  } catch (err) {
    return { ok: false, reason: `could not create coverage dir: ${String(err)}` };
  }
  try {
    const args = [
      'bun',
      'test',
      '--coverage',
      '--coverage-reporter=lcov',
      `--coverage-dir=${covDir}`,
    ];
    if (testPaths && testPaths.length > 0) args.push(...testPaths);
    Bun.spawnSync(args, { cwd: repoRoot, stdout: 'ignore', stderr: 'ignore' });
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

/** Options for `buildCoverageProvider`. */
export interface CoverageProviderOptions {
  /** Per-file coveredRatio bar (item 3). Defaults to DEFAULT_COVERAGE_THRESHOLD. */
  threshold?: number;
  /** The unit's source files — enables scoped collection (item 2). */
  scopeFiles?: string[];
  /** Candidate test files to derive the scoped set from (e.g. `git ls-files tests`). */
  testFiles?: string[];
}

/**
 * Build the L1 coverage provider for a repo. Collects coverage up front and caches the
 * parsed map, so `coverageOf` answers cheaply. Returns `undefined` (provider ABSENT —
 * fail-open, OBJ-02) when coverage cannot be collected or yields no data.
 *
 * SCOPE REDUCTION (item 2): when `scopeFiles` is given, the up-front collect is scoped to
 * the unit's mirrored test files (`deriveUnitTestPaths`); a covered region is answered from
 * that cheap run. A region that reads UNCOVERED under the scoped run ESCALATES to a one-off
 * full-suite collect before concluding uncovered, so a heuristic miss can never produce a
 * false uncovered — it only costs the (rare) escalation. No mirror found, or a failed
 * scoped collect, falls back to the full suite immediately.
 */
export function buildCoverageProvider(
  repoRoot: string,
  deps: CoverageDeps = { collect: defaultCollect },
  opts: CoverageProviderOptions = {},
): CoverageProvider | undefined {
  const threshold = opts.threshold ?? DEFAULT_COVERAGE_THRESHOLD;
  const scopeFiles = opts.scopeFiles ?? [];
  const derived =
    scopeFiles.length > 0 ? deriveUnitTestPaths(scopeFiles, opts.testFiles ?? []) : [];
  const scopedPaths = derived.length > 0 ? derived : undefined; // undefined → full suite

  let res = deps.collect(repoRoot, scopedPaths);
  let usedScope = scopedPaths !== undefined;
  if ((!res.ok || !res.lcov) && usedScope) {
    res = deps.collect(repoRoot); // scoped collect failed → full-suite fallback
    usedScope = false;
  }
  if (!res.ok || !res.lcov) return undefined;
  const map = parseLcov(res.lcov);
  if (map.size === 0) return undefined;

  // If we already collected the full suite, no escalation is possible/needed.
  let fullMap: CoverageMap | null = usedScope ? null : map;
  return {
    coverageOf: (region) => {
      const verdict = regionCoverage(map, region, threshold);
      if (verdict.status === 'covered' || !usedScope) return verdict;
      // scoped run did not witness the region — confirm against the full suite before
      // concluding uncovered (the scoped test set may simply not import this file).
      if (fullMap === null) {
        const full = deps.collect(repoRoot);
        fullMap = full.ok && full.lcov ? parseLcov(full.lcov) : new Map();
      }
      return regionCoverage(fullMap, region, threshold);
    },
  };
}
