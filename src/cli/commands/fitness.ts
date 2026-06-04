import { isAbsolute, join, resolve } from 'node:path';
import { defineCommand } from 'citty';
import { sarifToViolationIds } from '~/acg/fitness/codeql-provider';
import {
  type EvaluatorProvider,
  type FitnessContext,
  runFitness,
} from '~/acg/fitness/fitness-runner';
import { FitnessFunctionStore } from '~/core/fitness-function-store';
import { ensureDir, resolveRepoRootForCreate, writeJson as writeJsonFile } from '~/core/fs';
import { acgAssuranceSnapshot } from '~/schemas/acg-assurance-snapshot';
import { type AcgFitnessFunction, acgFitnessFunction } from '~/schemas/acg-fitness-function';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/** Spec prefix selecting the CodeQL SARIF source instead of a shell command. */
const CODEQL_SARIF_PREFIX = 'codeql-sarif:';

/**
 * Deterministic provider. Two deterministic sources, selected by `evaluator.spec`:
 *  - `codeql-sarif:<path>` → parse the SARIF and project findings to normalized
 *    violation identities (남은 일 #3, CodeQL provider). A missing SARIF is
 *    fail-closed: skipped with a reason (never a fabricated pass — the caller must
 *    produce it first via `ditto codeql review`).
 *  - anything else → run `spec` as a shell command, one (caller-normalized)
 *    violation identity per stdout line.
 * Non-deterministic modes (llm_judged/executed) are not wired in v0 → skip+reason.
 */
function commandProvider(repoRoot: string): EvaluatorProvider {
  return {
    evaluate: async (fn) => {
      if (fn.evaluator.mode !== 'deterministic') {
        return {
          skipped: { reason: `${fn.evaluator.mode} provider not wired (v0: deterministic only)` },
          violationIds: [],
        };
      }
      const spec = fn.evaluator.spec;
      if (spec.startsWith(CODEQL_SARIF_PREFIX)) {
        const rel = spec.slice(CODEQL_SARIF_PREFIX.length).trim();
        const sarifPath = isAbsolute(rel) ? rel : resolve(repoRoot, rel);
        const file = Bun.file(sarifPath);
        if (!(await file.exists())) {
          return {
            skipped: {
              reason: `codeql-sarif source not found: ${sarifPath} (run ditto codeql review first)`,
            },
            violationIds: [],
          };
        }
        return { violationIds: sarifToViolationIds(await file.text()) };
      }
      const proc = Bun.spawnSync(['sh', '-c', spec], { cwd: repoRoot });
      const out = proc.stdout?.toString() ?? '';
      const violationIds = out
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return { violationIds };
    },
  };
}

function parseFunctions(raw: unknown): AcgFitnessFunction[] {
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((f) => acgFitnessFunction.parse(f));
}

export const fitnessCommand = defineCommand({
  meta: { name: 'fitness', description: 'Run ACG fitness functions and emit an AssuranceSnapshot' },
  subCommands: {
    run: defineCommand({
      meta: {
        name: 'run',
        description:
          'Evaluate fitness function(s) per the ADR-0004 cost policy → AssuranceSnapshot',
      },
      args: {
        'work-item': { type: 'string', description: 'Work item id', required: true },
        from: {
          type: 'string',
          description:
            "Path to a fitness-function JSON (or array). Omit to load the work item's stored fitness-functions.json",
        },
        trigger: { type: 'string', description: 'per_change|periodic (default per_change)' },
        period: { type: 'string', description: 'daily|weekly|on_release (for trigger=periodic)' },
        risk: { type: 'string', description: 'low|medium|high (executed risk-tiered scheduling)' },
        'risk-known': {
          type: 'boolean',
          default: false,
          description:
            'Risk tier is known (from ImpactGraph). Default false → fail-closed escalate',
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
        try {
          const repoRoot = await resolveRepoRootForCreate();
          const fromPath = typeof args.from === 'string' ? args.from : undefined;
          let functions: AcgFitnessFunction[];
          if (fromPath) {
            try {
              functions = parseFunctions(JSON.parse(await Bun.file(fromPath).text()));
            } catch (err) {
              writeError(
                `fitness run: cannot read valid fitness-function(s) from ${fromPath}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
              process.exit(USAGE_ERROR_EXIT);
              return;
            }
          } else {
            const stored = await new FitnessFunctionStore(repoRoot).read(args['work-item']);
            if (stored === null) {
              writeError(
                `fitness run: no --from and no stored fitness-functions.json for ${args['work-item']} (run \`ditto change-contract\` first, or pass --from)`,
              );
              process.exit(USAGE_ERROR_EXIT);
              return;
            }
            functions = stored;
          }
          const ctx: FitnessContext = {
            trigger: args.trigger === 'periodic' ? 'periodic' : 'per_change',
            period: args.period as FitnessContext['period'],
            changeRef: args['work-item'],
            risk: args.risk as FitnessContext['risk'],
            riskKnown: args['risk-known'],
            producedAt: new Date().toISOString(),
          };
          const snapshot = await runFitness(functions, ctx, commandProvider(repoRoot));
          const path = join(
            repoRoot,
            '.ditto',
            'work-items',
            args['work-item'],
            'assurance-snapshot.json',
          );
          await ensureDir(join(repoRoot, '.ditto', 'work-items', args['work-item']));
          await writeJsonFile(path, acgAssuranceSnapshot, snapshot);

          const failed = snapshot.results.filter((r) => r.outcome === 'fail').length;
          if (format === 'json') {
            writeJson({
              work_item_id: args['work-item'],
              results: snapshot.results.length,
              failed,
              outcomes: snapshot.results.map((r) => ({ id: r.function_id, outcome: r.outcome })),
            });
          } else {
            writeHuman(
              `fitness: ${snapshot.results.length} function(s), ${failed} fail → assurance-snapshot.json`,
            );
          }
          if (failed > 0) process.exit(RUNTIME_ERROR_EXIT);
        } catch (err) {
          writeError(`fitness run failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(RUNTIME_ERROR_EXIT);
        }
      },
    }),
  },
});
