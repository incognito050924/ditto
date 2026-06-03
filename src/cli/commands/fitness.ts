import { join } from 'node:path';
import { defineCommand } from 'citty';
import {
  type EvaluatorProvider,
  type FitnessContext,
  runFitness,
} from '~/acg/fitness/fitness-runner';
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

/**
 * Deterministic command provider: runs `evaluator.spec` as a shell command and
 * treats each stdout line as a (caller-normalized) violation identity. Non
 * deterministic modes (llm_judged/executed) are not wired in v0 → skipped with a
 * reason (fail-closed: never fabricate a pass).
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
      const proc = Bun.spawnSync(['sh', '-c', fn.evaluator.spec], { cwd: repoRoot });
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
          description: 'Path to a fitness-function JSON (or array)',
          required: true,
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
          let functions: AcgFitnessFunction[];
          try {
            functions = parseFunctions(JSON.parse(await Bun.file(args.from).text()));
          } catch (err) {
            writeError(
              `fitness run: cannot read valid fitness-function(s) from ${args.from}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            process.exit(USAGE_ERROR_EXIT);
            return;
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
