/**
 * HEAD↔worktree absolute unit debt (ADR-0019 D3, wi_260615lj6 ac-2). The §4.4 full-bar
 * gate requires a debt DECREASE; `decideUnitTidy` needs real before/after violation counts
 * instead of refactor.ts's `before == after` placeholder.
 *
 * It materializes OLD = HEAD as a worktree (`createWorktreeForRun`), runs the standing
 * fitness analyzer there → `beforeIds`, runs it on the working tree → `afterIds`, and
 * folds them with `assessUnitDebt` (set-size counts). The worktree is always torn down.
 *
 * FAIL-OPEN (ADR-0019 D4): if either fitness run degrades (codeql absent/failed) or any
 * orchestration step throws, debt is UNKNOWN → `ok:false` (no debt). The caller then keeps
 * the unit at diff-only — never a hard block, never a fabricated decrease.
 *
 * The orchestrator core holds NO codeql/git path logic (that lives in the default deps),
 * so it stays pure-orchestration and unit-testable with plain mocks.
 */
import { join } from 'node:path';
import { codeqlCacheDir } from '~/core/codeql/host-deps';
import { type WorktreeHandle, createWorktreeForRun, removeRunWorktree } from '~/core/worktree';
import { analyzeStandingFitness, defaultStandingFitnessDeps } from '../fitness/standing-fitness';
import type { StandingFitnessResult } from '../fitness/standing-fitness';
import { type UnitDebt, assessUnitDebt } from './unit-refactor';

export interface UnitDebtInput {
  repoRoot: string;
  /** Repo-relative unit files (SARIF uris are repo-relative when sourceRoot is a repo root). */
  unitFiles: readonly string[];
  /** Cyclomatic-complexity threshold (passed through to the analyzer). */
  threshold?: number;
}

/** One side of the differential — OLD (HEAD worktree) or NEW (working tree). */
export interface AnalyzeSide {
  repoRoot: string;
  /** Source root the fitness DB is built from. */
  sourceRoot: string;
  unitFiles: readonly string[];
  threshold?: number;
  side: 'old' | 'new';
}

/** Injectable seams — defaults touch git + codeql; tests pass mocks. */
export interface UnitDebtDeps {
  createWorktree: (repoRoot: string, runId: string) => WorktreeHandle | Promise<WorktreeHandle>;
  removeWorktree: (repoRoot: string, relativePath: string) => void;
  /** Run the standing fitness analyzer for one source root (the default decides its paths). */
  analyze: (side: AnalyzeSide) => Promise<StandingFitnessResult>;
}

export interface UnitDebtResult {
  /** True when both fitness runs succeeded and debt was computed. */
  ok: boolean;
  /** Present only when ok — the OLD↔NEW absolute debt. */
  debt?: UnitDebt;
  /** Set when ok:false — why debt is unknown (fail-open). */
  degradedReason?: string;
}

/** A stable-enough run id for the worktree (no Date.now/random — keeps resume deterministic). */
function debtRunId(unitFiles: readonly string[]): string {
  let h = 0;
  for (const f of unitFiles) for (let i = 0; i < f.length; i++) h = (h * 31 + f.charCodeAt(i)) | 0;
  return `debt-${(h >>> 0).toString(36)}`;
}

/**
 * Measure OLD↔NEW absolute debt for a unit. Default deps run real git worktrees + the
 * codeql fitness analyzer; tests inject mocks. Always fail-open: a degraded fitness run or
 * any throw yields `ok:false` (debt unknown), and the worktree is always removed.
 */
export async function measureUnitDebt(
  input: UnitDebtInput,
  deps: UnitDebtDeps = defaultUnitDebtDeps,
): Promise<UnitDebtResult> {
  let handle: WorktreeHandle | undefined;
  try {
    handle = await deps.createWorktree(input.repoRoot, debtRunId(input.unitFiles));
  } catch (err) {
    return {
      ok: false,
      degradedReason: `unit debt degraded: could not create HEAD worktree (${err instanceof Error ? err.message : String(err)}) — diff-only (fail-open)`,
    };
  }

  try {
    const before = await deps.analyze({
      repoRoot: input.repoRoot,
      sourceRoot: handle.absolutePath, // OLD = HEAD worktree
      unitFiles: input.unitFiles,
      threshold: input.threshold,
      side: 'old',
    });
    const after = await deps.analyze({
      repoRoot: input.repoRoot,
      sourceRoot: input.repoRoot, // NEW = working tree
      unitFiles: input.unitFiles,
      threshold: input.threshold,
      side: 'new',
    });
    if (!before.ok || !after.ok) {
      return {
        ok: false,
        degradedReason: `unit debt degraded: fitness analyzer unavailable (${before.degradedReason ?? after.degradedReason ?? 'codeql failed'}) — diff-only (fail-open)`,
      };
    }
    return { ok: true, debt: assessUnitDebt(before.violationIds, after.violationIds) };
  } catch (err) {
    return {
      ok: false,
      degradedReason: `unit debt degraded: ${err instanceof Error ? err.message : String(err)} — diff-only (fail-open)`,
    };
  } finally {
    try {
      deps.removeWorktree(input.repoRoot, handle.relativePath);
    } catch {
      // worktree teardown failure is non-fatal to the measurement (best-effort cleanup).
    }
  }
}

/** Per-(side) codeql work paths under the repo's codeql cache dir (DB reuse, gitignored). */
function fitnessPaths(repoRoot: string, side: 'old' | 'new') {
  const base = join(codeqlCacheDir(repoRoot, 'javascript'), 'fitness', side);
  return {
    dbPath: join(base, 'db'),
    sarifPath: join(base, 'out.sarif'),
    queryDir: join(base, 'ql'),
  };
}

/** Production seams: real git worktree + the real codeql fitness analyzer with cache paths. */
export const defaultUnitDebtDeps: UnitDebtDeps = {
  createWorktree: createWorktreeForRun,
  removeWorktree: removeRunWorktree,
  analyze: (side) =>
    analyzeStandingFitness(
      {
        repoRoot: side.repoRoot,
        sourceRoot: side.sourceRoot,
        unitFiles: side.unitFiles,
        threshold: side.threshold,
        ...fitnessPaths(side.repoRoot, side.side),
      },
      defaultStandingFitnessDeps,
    ),
};
