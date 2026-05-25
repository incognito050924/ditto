import { defineCommand } from 'citty';
import { EvidenceStore } from '~/core/evidence-store';
import { resolveRepoRootForCreate } from '~/core/fs';
import { WorkItemStore } from '~/core/work-item-store';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  extractDashDashTail,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

interface RunResult {
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
}

function runChildCommand(tail: string[]): RunResult {
  if (tail.length === 0) {
    throw new Error('empty command tail');
  }
  const started = Date.now();
  const proc = Bun.spawnSync(tail, {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  return {
    exit_code: proc.exitCode ?? -1,
    duration_ms: Date.now() - started,
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
  };
}

export const verifyCommand = defineCommand({
  meta: {
    name: 'verify',
    description: 'Run a command after -- and record it as evidence for a work item',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id to verify',
      required: true,
    },
    criterion: {
      type: 'string',
      description:
        'Acceptance criterion id; if omitted, evidence is recorded without verdict change',
      required: false,
    },
    output: {
      type: 'string',
      description: 'Output format: human|json',
      default: 'human',
    },
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
    const tail = extractDashDashTail();
    if (tail === null || tail.length === 0) {
      writeError(
        'ditto verify requires a command after `--`. Example: ditto verify <wi> -- echo ok',
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const workStore = new WorkItemStore(repoRoot);
    const evidenceStore = new EvidenceStore(repoRoot);
    try {
      const item = await workStore.get(args.workId);
      if (args.criterion && !item.acceptance_criteria.find((c) => c.id === args.criterion)) {
        writeError(`acceptance criterion ${args.criterion} not found on ${item.id}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const startedAt = new Date().toISOString();
      const result = runChildCommand(tail);
      const entry = {
        ts: startedAt,
        kind: 'command' as const,
        command: tail.join(' '),
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        work_item_id: item.id,
        ...(args.criterion ? { criterion_id: args.criterion } : {}),
      };
      await evidenceStore.appendCommand(item.id, entry);

      if (args.criterion) {
        const nextVerdict = result.exit_code === 0 ? ('pass' as const) : ('fail' as const);
        await workStore.update(item.id, (cur) => ({
          ...cur,
          acceptance_criteria: cur.acceptance_criteria.map((c) =>
            c.id === args.criterion
              ? {
                  ...c,
                  verdict: nextVerdict,
                  evidence: [
                    ...c.evidence,
                    {
                      kind: 'command' as const,
                      command: tail.join(' '),
                      summary: `exit ${result.exit_code}`,
                    },
                  ],
                }
              : c,
          ),
        }));
      }

      if (format === 'json') {
        writeJson({
          work_item_id: item.id,
          criterion_id: args.criterion ?? null,
          exit_code: result.exit_code,
          duration_ms: result.duration_ms,
          verdict_updated: args.criterion ? (result.exit_code === 0 ? 'pass' : 'fail') : null,
        });
      } else {
        writeHuman(`exit ${result.exit_code} (${result.duration_ms}ms)`);
        if (args.criterion) {
          writeHuman(`verdict for ${args.criterion}: ${result.exit_code === 0 ? 'pass' : 'fail'}`);
        } else {
          writeHuman('no --criterion given; evidence only, verdict unchanged');
        }
      }
      if (result.exit_code !== 0) {
        process.exit(RUNTIME_ERROR_EXIT);
      }
    } catch (err) {
      writeError(`verify failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});
