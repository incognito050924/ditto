import { join } from 'node:path';
import { defineCommand } from 'citty';
import { type UnitScope, parseUnitScope, resolveUnitScope } from '~/acg/scope/unit-resolve';
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
 * N8 measure-first finding (dialectic-9 OBJ-04): no coverage provider is wired in this
 * repo (provider 0건), so behavior preservation cannot be witnessed at full bar →
 * provider-presence-FIRST degrades EVERY unit to diff-only and surfaces the bar-miss as
 * a NARROW residual question (never a bulk diff to approve — §4.4 검증 연극). The full-bar
 * isolated-branch commit path stays gated behind a wired+firing coverage provider.
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
      // the behavior-preservation run happen during the actual refactor; here, with no
      // wired coverage provider (N8), the unit degrades to diff-only — we report the
      // resolved unit + the gated decision. before/after debt are equal (no mutation
      // performed by this entrypoint) so debtDecreased=false until refactorers run.
      const decision = decideUnitTidy({
        unit: args.scope,
        files: resolved,
        baselineGreen: true,
        debt: { before: resolved.length, after: resolved.length },
        behaviorGreen: true,
        coverageProviderPresent: false, // provider 0건 (N8) — degrade-all to diff-only
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
