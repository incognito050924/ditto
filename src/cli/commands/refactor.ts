import { join } from 'node:path';
import { defineCommand } from 'citty';
import { type UnitScope, parseUnitScope, resolveUnitScope } from '~/acg/scope/unit-resolve';
import { buildCoverageProvider } from '~/acg/tidy/coverage-provider';
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
 * `bun test --coverage`) is now wired here — `coverageProviderPresent`/`unitCovered`
 * come from a real run, not a hardcoded false. When coverage cannot be collected the
 * provider is ABSENT and we fail open to diff-only + a NARROW residual question (never a
 * bulk diff to approve — §4.4 검증 연극; OBJ-02). This surface MEASURES the unit (it does
 * not itself refactor), so absolute debt before==after here and the §4.4 full-bar
 * auto-commit fires only once a real tidy has reduced the debt (decideUnitTidy gates it).
 */

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

      // Standing-code baseline = HEAD. The absolute-debt before/after measurement and
      // the behavior-preservation run happen during the actual refactor; this entrypoint
      // only MEASURES, so before==after (debtDecreased=false until a refactorer runs).
      // The L1 coverage provider, however, IS consulted here: if coverage can be
      // collected we report whether the unit is covered (full-bar-eligible); if not, we
      // fail open to diff-only (OBJ-02).
      const coverageProvider = buildCoverageProvider(repoRoot, undefined, {
        scopeFiles: resolved,
        testFiles: trackedTestFiles(repoRoot),
      });
      const coverageProviderPresent = coverageProvider !== undefined;
      const unitCovered = coverageProvider
        ? (await coverageProvider.coverageOf({ files: resolved })).status === 'covered'
        : undefined;
      const decision = decideUnitTidy({
        unit: args.scope,
        files: resolved,
        baselineGreen: true,
        debt: { before: resolved.length, after: resolved.length },
        behaviorGreen: true,
        coverageProviderPresent,
        unitCovered,
      });

      if (format === 'json') {
        writeJson({
          unit: args.scope,
          files: resolved,
          autoCommit: decision.autoCommit,
          barMet: decision.barMet,
          residualQuestions: decision.residualQuestions,
        });
      } else {
        writeHuman(
          `refactor ${args.scope}: ${resolved.length} file(s), autoCommit=${decision.autoCommit}, barMet=${decision.barMet}`,
        );
        for (const q of decision.residualQuestions) writeHuman(`  residual: ${q}`);
      }
    } catch (err) {
      writeError(`refactor failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});
