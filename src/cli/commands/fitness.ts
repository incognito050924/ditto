import { defineCommand } from 'citty';
import { commandProvider } from '~/acg/fitness/command-provider';
import { assessDrift, computeDrift, loadAssuranceSnapshots } from '~/acg/fitness/drift';
import { executingProvider } from '~/acg/fitness/executed-provider';
import { type FitnessContext, runFitness } from '~/acg/fitness/fitness-runner';
import { compositeProvider } from '~/acg/fitness/injected-provider';
import { localDir } from '~/core/ditto-paths';
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
        verdicts: {
          type: 'string',
          description:
            'Path to an agent-produced acg.fitness-verdict.v1 file. Routes llm_judged/executed functions to the injected provider; deterministic still runs commands',
        },
        execute: {
          type: 'boolean',
          default: false,
          description:
            'Run executed-mode functions directly (spec + execution policy: timeout/retries/flake) instead of consuming injected verdicts. Costly — opt-in (ADR-0004 Q4). llm_judged still needs --verdicts',
        },
        output: { type: 'string', description: 'Output format: human|json', default: 'human' },
      },
      run: async ({ args }) => {
        let format: ReturnType<typeof parseOutputFormat>;
        try {
          format = parseOutputFormat(String(args.output));
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
            const stored = await new FitnessFunctionStore(repoRoot).read(String(args['work-item']));
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
            ...(args.period !== undefined
              ? { period: args.period as NonNullable<FitnessContext['period']> }
              : {}),
            changeRef: String(args['work-item']),
            ...(args.risk !== undefined
              ? { risk: args.risk as NonNullable<FitnessContext['risk']> }
              : {}),
            riskKnown: args['risk-known'] === true,
            producedAt: new Date().toISOString(),
          };
          const verdictsPath = typeof args.verdicts === 'string' ? args.verdicts : undefined;
          // --execute: executed-mode를 직접 실행(executingProvider). 미지정이면 기존 경로
          // (verdicts→injected 합성, 아니면 deterministic-only command) 그대로(무회귀).
          const provider = args.execute
            ? executingProvider(repoRoot, verdictsPath)
            : verdictsPath
              ? compositeProvider(repoRoot, verdictsPath)
              : commandProvider(repoRoot);
          const snapshot = await runFitness(functions, ctx, provider);
          const path = localDir(
            repoRoot,
            'work-items',
            String(args['work-item']),
            'assurance-snapshot.json',
          );
          await ensureDir(localDir(repoRoot, 'work-items', String(args['work-item'])));
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
    drift: defineCommand({
      meta: {
        name: 'drift',
        description:
          'Aggregate AssuranceSnapshots across work items into a per-function SLOP trend (단계8)',
      },
      args: {
        gate: {
          type: 'boolean',
          default: false,
          description:
            'Exit non-zero when a function is on a rising SLOP trend (CI gate on accumulation across changes). C1 scheduler is a CI/cron concern, not in-repo',
        },
        'min-new-violations': {
          type: 'string',
          description:
            'Gate threshold: only flag rising functions with at least N cumulative new violations across changes (default 0 = any rising)',
        },
        output: { type: 'string', description: 'Output format: human|json', default: 'human' },
      },
      run: async ({ args }) => {
        let format: ReturnType<typeof parseOutputFormat>;
        try {
          format = parseOutputFormat(String(args.output));
        } catch (err) {
          writeError(err instanceof Error ? err.message : String(err));
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        try {
          const repoRoot = await resolveRepoRootForCreate();
          const report = computeDrift(await loadAssuranceSnapshots(repoRoot));
          const minNew = Number.parseInt(String(args['min-new-violations'] ?? '0'), 10);
          const assessment = args.gate
            ? assessDrift(report, Number.isNaN(minNew) ? 0 : minNew)
            : null;

          if (format === 'json') {
            writeJson(
              assessment
                ? {
                    ...report,
                    gate: {
                      concerning: assessment.concerning.map((f) => f.function_id),
                      min_new_violations: assessment.min_new_violations,
                    },
                  }
                : report,
            );
          } else if (report.snapshots === 0) {
            writeHuman('drift: no AssuranceSnapshots across work items yet (nothing to trend)');
          } else {
            writeHuman(
              `drift: ${report.functions.length} function(s) across ${report.snapshots} snapshot(s)`,
            );
            for (const f of report.functions) {
              const v =
                f.first_violations === null ? '—' : `${f.first_violations}→${f.last_violations}`;
              writeHuman(
                `  ${f.direction.padEnd(12)} ${f.function_id} (violations ${v}, +${f.cumulative_new_violations} new across changes, ${f.fail_count} fail)`,
              );
            }
            if (assessment && assessment.concerning.length > 0) {
              writeHuman(`\nGATE: ${assessment.concerning.length} function(s) on a rising trend:`);
              for (const r of assessment.reasons) writeHuman(`  ${r}`);
            }
          }
          // 게이트: 주의 추세가 있으면 비정상 종료(CI가 SLOP 가속에 빌드 실패).
          if (assessment && assessment.concerning.length > 0) process.exit(RUNTIME_ERROR_EXIT);
        } catch (err) {
          writeError(`fitness drift failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(RUNTIME_ERROR_EXIT);
        }
      },
    }),
  },
});
