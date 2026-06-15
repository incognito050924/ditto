import { join } from 'node:path';
import { defineCommand } from 'citty';
import { type UnitScope, parseUnitScope, resolveUnitScope } from '~/acg/scope/unit-resolve';
import { buildCoverageProvider, deriveUnitTestPaths } from '~/acg/tidy/coverage-provider';
import {
  type L2WorktreeVerdict,
  defaultL2WorktreeDeps,
  runL2WorktreeDifferential,
} from '~/acg/tidy/l2-worktree-differential';
import { commitTidyStructural } from '~/acg/tidy/tidy-commit';
import { measureUnitDebt } from '~/acg/tidy/unit-debt';
import { decideUnitTidy } from '~/acg/tidy/unit-refactor';
import { readArchitectureSpec, resolveRepoRootForCreate } from '~/core/fs';
import { acgArchitectureSpec } from '~/schemas/acg-architecture-spec';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto refactor --scope <unit>` (80-plan §9, WU-4) — UNIT-scoped, behavior-preserving
 * tidy of STANDING code (baseline = HEAD), NOT a merge-base diff. The user names an
 * architecture unit (`all | component:<name> | layer:<name> | api | <glob>`); it is
 * resolved to a standing-code file set via the SHARED resolver (`~/acg/scope/unit-resolve`,
 * also used by WU-5 `ditto review`), the unit's absolute fitness debt is measured, and
 * the §4.4 bar gates an isolated-branch auto-commit.
 *
 * COVERAGE WIRING (wi_260615889): the L1 coverage provider (`buildCoverageProvider`,
 * `bun test --coverage`) is wired here — `coverageProviderPresent`/`unitCovered` come from
 * a real run, not a hardcoded false. When coverage cannot be collected the provider is
 * ABSENT and we fail open to diff-only + a NARROW residual question (never a bulk diff to
 * approve — §4.4 검증 연극; OBJ-02).
 *
 * FULL-BAR WIRING (wi_260615lj6 / dialectic-10): the three formerly-hardcoded inputs are
 * replaced by their REAL sources, ATOMICALLY (OBJ-D — never piecemeal, or a stale
 * placeholder false-fires the bar):
 *   - baselineGreen ← L2's OLD/HEAD test outcome,
 *   - behaviorGreen ← L2 worktree differential (`status==='unrefuted'`),
 *   - debt before/after ← `measureUnitDebt` (HEAD↔worktree CodeQL complexity counts).
 * The model: a refactorer has ALREADY applied the tidy to the working tree (NEW); this
 * surface measures OLD(HEAD)↔NEW and, when the §4.4 bar is met, auto-commits the working
 * tree on an ISOLATED branch via `commitTidyStructural` (push 0 — ADR-0017 D8).
 *
 * FAIL-OPEN (OBJ-C): the L2 and debt measurements are each fail-open (degrade to diff-only,
 * never throw) AND time-boxed here, so a missing/slow/hanging codeql or worktree degrades
 * to diff-only rather than a hard block. The expensive measurements run ONLY when the unit
 * is full-bar-eligible (covered + has characterization tests); otherwise we skip them and
 * decideUnitTidy degrades on the coverage gate.
 */

/** Hang-guard for the codeql/test subprocesses (OBJ-C 타임박스). Override via env. */
const MEASURE_TIMEOUT_MS = Number(process.env.DITTO_REFACTOR_TIMEOUT_MS) || 300_000;

/** Race a measurement against a timeout; on timeout resolve to a degraded fallback. */
async function withTimebox<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A safe branch slug for the isolated tidy branch from a unit scope string. */
function tidyBranchSlug(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unit';
}

/** Tracked standing files under `src/` at HEAD (git ls-files — deterministic). */
function trackedSrcFiles(repoRoot: string): string[] {
  const r = Bun.spawnSync(['git', 'ls-files', '--', 'src'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${r.stderr?.toString().trim() ?? ''}`);
  }
  return r.stdout
    .toString()
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /\.[cm]?tsx?$/.test(s) && !/\.(test|spec)\./.test(s));
}

/** Tracked test files under `tests/` — used to scope the coverage run to the unit (item 2). */
function trackedTestFiles(repoRoot: string): string[] {
  const r = Bun.spawnSync(['git', 'ls-files', '--', 'tests'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (r.exitCode !== 0) return []; // no test list → coverage falls back to the full suite (safe)
  return r.stdout
    .toString()
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /\.[cm]?tsx?$/.test(s));
}

/** Load the repo's ArchitectureSpec if present (layer:<name> needs it); else undefined. */
async function loadArchSpec(repoRoot: string) {
  const specPath = join(repoRoot, '.ditto', 'architecture-spec.json');
  try {
    return await readArchitectureSpec(specPath, acgArchitectureSpec);
  } catch {
    return undefined; // layer:<name> resolves to nothing (conservative); other units unaffected.
  }
}

export const refactorCommand = defineCommand({
  meta: {
    name: 'refactor',
    description:
      'Unit-scoped behavior-preserving tidy of standing code (baseline=HEAD) — `--scope all|component:<name>|layer:<name>|api|<glob>`',
  },
  args: {
    scope: {
      type: 'string',
      description: 'Architecture unit: all | component:<name> | layer:<name> | api | <glob>',
      required: true,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    let unit: UnitScope;
    try {
      unit = parseUnitScope(args.scope);
    } catch (err) {
      writeError(`refactor: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const files = trackedSrcFiles(repoRoot);
      const archSpec = await loadArchSpec(repoRoot);
      const resolved = resolveUnitScope(unit, files, archSpec);

      // Standing-code baseline = HEAD. The L1 coverage provider gates full-bar eligibility.
      const testFiles = trackedTestFiles(repoRoot);
      const coverageProvider = buildCoverageProvider(repoRoot, undefined, {
        scopeFiles: resolved,
        testFiles,
      });
      const coverageProviderPresent = coverageProvider !== undefined;
      const unitCovered = coverageProvider
        ? (await coverageProvider.coverageOf({ files: resolved })).status === 'covered'
        : undefined;

      // Real full-bar inputs (OBJ-D atomic). Defaults are the SAFE values — baseline valid,
      // behavior NOT preserved, debt unknown (before==after) — so a unit that is not
      // full-bar-eligible (no coverage / not covered / no tests) degrades on the coverage
      // gate without paying for the expensive measurements.
      const testPaths = deriveUnitTestPaths(resolved, testFiles);
      let baselineGreen = true;
      let behaviorGreen = false;
      let debt = { before: 0, after: 0 };
      let l2Reason: string | undefined;
      if (coverageProviderPresent && unitCovered === true && testPaths.length > 0) {
        const l2 = await withTimebox(
          runL2WorktreeDifferential(
            { repoRoot, unitFiles: resolved, testPaths },
            defaultL2WorktreeDeps(repoRoot),
          ),
          MEASURE_TIMEOUT_MS,
          (): L2WorktreeVerdict => ({
            baselineGreen: false,
            status: 'unverified',
            autoCommit: 'diff-only',
            reviewHighRisk: true,
            reason: 'L2 timed out — degrade to diff-only (fail-open, OBJ-C)',
          }),
        );
        baselineGreen = l2.baselineGreen;
        behaviorGreen = l2.status === 'unrefuted';
        l2Reason = l2.reason;
        const debtRes = await withTimebox(
          measureUnitDebt({ repoRoot, unitFiles: resolved }),
          MEASURE_TIMEOUT_MS,
          () => ({ ok: false as const, degradedReason: 'unit debt timed out — diff-only (OBJ-C)' }),
        );
        if (debtRes.ok && debtRes.debt) {
          debt = { before: debtRes.debt.before, after: debtRes.debt.after };
        }
      }

      const decision = decideUnitTidy({
        unit: args.scope,
        files: resolved,
        baselineGreen,
        debt,
        behaviorGreen,
        coverageProviderPresent,
        unitCovered,
      });

      // §4.4 full-bar met → auto-commit the working-tree tidy on an ISOLATED branch (push 0).
      let commit: ReturnType<typeof commitTidyStructural> | undefined;
      if (decision.barMet) {
        commit = commitTidyStructural({
          repoRoot,
          branch: `ditto-tidy/${tidyBranchSlug(args.scope)}`,
          files: [...resolved],
          message: `tidy(${args.scope}): structural — §4.4 full-bar auto-commit (behavior-preserved, debt ${debt.before}→${debt.after})`,
        });
      }

      if (format === 'json') {
        writeJson({
          unit: args.scope,
          files: resolved,
          autoCommit: decision.autoCommit,
          barMet: decision.barMet,
          baselineGreen,
          behaviorGreen,
          debt,
          residualQuestions: decision.residualQuestions,
          commit: commit ?? null,
          l2Reason: l2Reason ?? null,
        });
      } else {
        writeHuman(
          `refactor ${args.scope}: ${resolved.length} file(s), autoCommit=${decision.autoCommit}, barMet=${decision.barMet} (baselineGreen=${baselineGreen}, behaviorGreen=${behaviorGreen}, debt ${debt.before}→${debt.after})`,
        );
        if (commit) {
          writeHuman(
            commit.committed
              ? `  committed ${commit.sha?.slice(0, 9)} on ${commit.branch} (not pushed — D8)`
              : `  commit skipped: ${commit.reason}`,
          );
        }
        for (const q of decision.residualQuestions) writeHuman(`  residual: ${q}`);
      }
    } catch (err) {
      writeError(`refactor failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});
