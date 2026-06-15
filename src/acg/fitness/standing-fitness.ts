/**
 * Standing-code fitness analyzer (ADR-0019 D1 — dialectic-10 OBJ-A, wi_260615lj6 ac-1).
 *
 * `ditto refactor --scope`'s §4.4 full-bar requires a debt DECREASE, which needs a real
 * violation signal on STANDING code. ADR-0006 fixes CodeQL as the single static engine,
 * and ADR-0006 D2 forbids a TS-AST analyzer — so the signal is a CodeQL query.
 *
 * OBJ-A (verified): the stock `@kind treemap` metrics queries emit NO SARIF `results[]`
 * (and the duplication ones are `where none()`), so they yield zero violations. This
 * module therefore runs a CUSTOM `@kind problem` query — cyclomatic complexity above a
 * threshold — which DOES produce per-function SARIF alerts.
 *
 * IDENTITY: unlike `codeql-provider.ts` (drift use case — `rule@path#<top>`, line excluded
 * so a line move is not a new violation, which collapses every finding in a file to ONE),
 * the debt gate needs per-FUNCTION granularity so fixing 3 of 5 complex functions in a file
 * registers as a decrease. `assessUnitDebt` compares set SIZES (counts), not set diffs, so
 * the identity only has to be unique-per-function WITHIN a snapshot — `rule@path#L<startLine>`
 * (two functions cannot start on the same line) is exactly that. The line is intentionally
 * INCLUDED here (the opposite of the drift identity) for that reason.
 *
 * FAIL-OPEN (ADR-0019 D4): any codeql failure → ok:false + empty ids + degraded reason;
 * the caller treats absent debt as diff-only, never a hard block.
 */
import { makeRelationDeps } from '~/core/codeql/host-deps';
import { runCodeqlAnalysis } from '~/core/codeql/runner';
import { parseSarif } from '~/core/codeql/sarif';

/**
 * Default cyclomatic-complexity threshold. McCabe's original guidance is 10 as the point
 * above which a function is hard to test/maintain; we flag `> 10` (11+). A defensible,
 * standard default (ADR-0019 D1 requires one); a future binding may tune per-repo.
 */
export const DEFAULT_COMPLEXITY_THRESHOLD = 10;

/** Render the custom complexity problem query at threshold N (produces SARIF alerts). */
export function renderComplexityQuery(threshold: number): string {
  return `/**
 * @name High cyclomatic complexity
 * @description A function whose cyclomatic complexity exceeds the tidy threshold.
 * @kind problem
 * @problem.severity warning
 * @id ditto/high-cyclomatic-complexity
 */
import javascript
from Function func, int complexity
where complexity = func.getCyclomaticComplexity() and complexity > ${threshold}
select func, "Function has cyclomatic complexity " + complexity + " (> ${threshold})."
`;
}

/** The qlpack manifest for the generated fitness query (depends on the js library). */
export const FITNESS_QLPACK = `name: ditto/acg-fitness
version: 0.0.1
dependencies:
  codeql/javascript-all: "*"
`;

/** Normalize an lcov/SARIF uri to a comparable repo-relative key. */
function normalizePath(p: string): string {
  return p.trim().replace(/^\.\//, '');
}

export interface FitnessIdOptions {
  /** Repo-relative files of the unit; when given, only findings in these files are kept. */
  unitFiles?: readonly string[];
}

/**
 * Project SARIF alerts to the per-function fitness violation-identity set
 * `rule@path#L<startLine>` (deduped, optionally filtered to the unit's files). A finding
 * without a start line falls back to `#<top>` (rare for complexity alerts).
 */
export function sarifToFitnessViolationIds(
  sarifText: string,
  opts: FitnessIdOptions = {},
): string[] {
  const allow = opts.unitFiles ? new Set(opts.unitFiles.map(normalizePath)) : undefined;
  const ids = new Set<string>();
  for (const f of parseSarif(sarifText)) {
    const path = f.file ? normalizePath(f.file) : '<unknown>';
    if (allow && !allow.has(path)) continue;
    const site = f.startLine != null ? `L${f.startLine}` : '<top>';
    ids.add(`${f.ruleId}@${path}#${site}`);
  }
  return [...ids];
}

export interface StandingFitnessInput {
  repoRoot: string;
  /** Source root the DB is built from (repoRoot, or a HEAD worktree abs path). */
  sourceRoot: string;
  /** Repo-relative unit files to keep (paths are repo-relative in SARIF uris). */
  unitFiles: readonly string[];
  /** Cyclomatic-complexity threshold (defaults to DEFAULT_COMPLEXITY_THRESHOLD). */
  threshold?: number;
  /** Where to create the CodeQL DB. */
  dbPath: string;
  /** Where the SARIF is written/read. */
  sarifPath: string;
  /** Directory the generated qlpack + query are written into. */
  queryDir: string;
}

/** Injectable seams: write the query pack, and run codeql to produce SARIF text. */
export interface StandingFitnessDeps {
  writeText: (path: string, content: string) => Promise<void>;
  /** Build DB + analyze the query, returning the SARIF text. Throws on codeql failure. */
  runAnalysis: (input: StandingFitnessInput, queryPath: string) => Promise<string>;
}

export interface StandingFitnessResult {
  /** True when codeql ran and produced a SARIF we could project. */
  ok: boolean;
  /** Per-function violation identities for the unit (empty when degraded). */
  violationIds: string[];
  /** Set when ok:false — why the analyzer degraded (fail-open). */
  degradedReason?: string;
}

/**
 * Generate the query pack, run the codeql analysis, and project the SARIF to the unit's
 * per-function violation-identity set. Any failure degrades to `ok:false` + empty ids
 * (fail-open, ADR-0019 D4) — never throws.
 */
export async function analyzeStandingFitness(
  input: StandingFitnessInput,
  deps: StandingFitnessDeps,
): Promise<StandingFitnessResult> {
  const threshold = input.threshold ?? DEFAULT_COMPLEXITY_THRESHOLD;
  const queryPath = `${input.queryDir}/high-complexity.ql`;
  try {
    await deps.writeText(`${input.queryDir}/qlpack.yml`, FITNESS_QLPACK);
    await deps.writeText(queryPath, renderComplexityQuery(threshold));
    const sarifText = await deps.runAnalysis({ ...input, threshold }, queryPath);
    return {
      ok: true,
      violationIds: sarifToFitnessViolationIds(sarifText, { unitFiles: input.unitFiles }),
    };
  } catch (err) {
    return {
      ok: false,
      violationIds: [],
      degradedReason: `standing fitness degraded: ${err instanceof Error ? err.message : String(err)} — codeql unavailable/failed; diff-only (fail-open)`,
    };
  }
}

/**
 * Default codeql run: build a JS DB from `sourceRoot` and analyze the generated query into
 * SARIF, reusing the single-engine runner (ADR-0006) and the Bun-backed deps. The caller
 * must pass a FRESH `sarifPath` per run (OLD vs NEW differ) — the runner reuses an existing
 * SARIF as a cache. Throws on codeql failure so `analyzeStandingFitness` can fail open.
 */
export async function defaultRunAnalysis(
  input: StandingFitnessInput,
  queryPath: string,
): Promise<string> {
  const deps = makeRelationDeps();
  const result = await runCodeqlAnalysis(
    {
      repoRoot: input.repoRoot,
      sourceRoot: input.sourceRoot,
      language: 'javascript',
      commitSha: 'standing', // unused by the runner; cache is keyed on sarifPath existence
      dbPath: input.dbPath,
      sarifPath: input.sarifPath,
      suite: queryPath,
    },
    deps,
  );
  // runCodeqlAnalysis already parsed the SARIF; re-read the raw text for projection.
  return deps.readText(result.sarifPath);
}

/** Production seams for the standing fitness analyzer (real query writes + real codeql). */
export const defaultStandingFitnessDeps: StandingFitnessDeps = {
  writeText: async (path, content) => {
    await Bun.write(path, content);
  },
  runAnalysis: defaultRunAnalysis,
};
