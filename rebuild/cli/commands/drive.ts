import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineCommand } from 'citty';

import {
  runDrive,
  writeQueueStateAtomic,
  type DriveConfig,
  type DriveDeps,
  type DriveResult,
} from '../../drive/outer-loop';
import { LiveHost, makeLiveHostDeps } from '../../seam/live-host';
import { parseQueueState } from '../../state/queue-state';
import { liveCodexDeps } from '../../verify/codex';
import { listChangedFiles } from '../../util/git';
import { findRepoRoot } from '../../util/fs';
import { localDir } from '../../util/paths';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto drive <work-item-id>` — front the REBUILT autopilot outer loop
 * (`rebuild/drive/outer-loop.ts:runDrive`) over the real Claude Code CLI host
 * (`rebuild/seam/live-host.ts`). Each round is one fresh/resumed `claude --print`
 * drive step against the work item's disposition queue (`queue.json`), gated by
 * the frozen-oracle integrity check, intent-lock, backstop, and an external
 * (codex) completion authority. The loop runs to queue-drain with no human
 * intervention; a non-drained terminal outcome exits non-zero.
 *
 * The queue state is the per-developer Run-tier artifact at
 * `.ditto/local/work-items/<id>/state/queue.json` (override with `--state`); it
 * must be seeded before the drive (runDrive reads it, never creates it). Oracle
 * paths, round/timeout ceilings, and the host autonomy knobs come from flags.
 */

function parsePositiveInt(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseOraclePaths(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export const driveCommand = defineCommand({
  meta: {
    name: 'drive',
    description:
      'Drive a work item’s disposition queue to fixpoint with the rebuilt autopilot outer loop (real claude host)',
  },
  args: {
    'work-item': { type: 'positional', description: 'Work item id', required: true },
    state: {
      type: 'string',
      description:
        'Path to the queue-state JSON (default: .ditto/local/work-items/<id>/state/queue.json)',
      required: false,
    },
    'max-rounds': {
      type: 'string',
      description: 'Absolute round ceiling — hard churn-livelock stop (default 10)',
      default: '10',
    },
    'max-no-progress': {
      type: 'string',
      description: 'Backstop: max consecutive no-progress rounds before parking (default 3)',
      default: '3',
    },
    timeout: {
      type: 'string',
      description: 'Per-drive-step wall-clock budget in ms (default 290000)',
      default: '290000',
    },
    oracle: {
      type: 'string',
      description:
        'Comma-separated repo-relative oracle files to freeze (frozen tests/gate/verify/schema)',
      required: false,
    },
    cwd: {
      type: 'string',
      description: 'Working directory for the spawned claude drive step (default: repo root)',
      required: false,
    },
    settings: {
      type: 'string',
      description: '--settings path for the spawned session (spawn-scoped Stop-hook injection)',
      required: false,
    },
    'skip-permissions': {
      type: 'boolean',
      description: 'Pass --dangerously-skip-permissions to the spawned session (headless autonomy)',
      default: false,
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
    }

    const absoluteRoundCeiling = parsePositiveInt(args['max-rounds'], 10);
    const maxNoProgressRounds = parsePositiveInt(args['max-no-progress'], 3);
    const timeoutMs = parsePositiveInt(args.timeout, 290_000);
    if (absoluteRoundCeiling === null || maxNoProgressRounds === null || timeoutMs === null) {
      writeError('--max-rounds, --max-no-progress, and --timeout must be positive integers');
      process.exit(USAGE_ERROR_EXIT);
    }

    const repoRoot = await findRepoRoot();
    const workItemId = args['work-item'];
    const statePath =
      args.state ?? localDir(repoRoot, 'work-items', workItemId, 'state', 'queue.json');
    const cwd = args.cwd ?? repoRoot;

    // DriveDeps — every crossing is constructed from CLI input + rebuilt modules:
    //  readState/writeState  → the queue.json at statePath (parse/atomic-write)
    //  readOracleContent     → repo-relative file read (null when absent)
    //  roundDiff             → working-tree changes via the rebuilt git util
    //  codex                 → the shipped live codex cross-check port
    const deps: DriveDeps = {
      readState: () => parseQueueState(readFileSync(statePath, 'utf8')),
      writeState: (state) => writeQueueStateAtomic(statePath, state),
      readOracleContent: (path) => {
        const abs = join(repoRoot, path);
        return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      },
      roundDiff: () => listChangedFiles(repoRoot),
      codex: liveCodexDeps,
    };

    const config: DriveConfig = {
      absoluteRoundCeiling,
      maxNoProgressRounds,
      timeoutMs,
      oraclePaths: parseOraclePaths(args.oracle),
    };

    const host = new LiveHost(
      makeLiveHostDeps({
        cwd,
        settingsPath: args.settings,
        skipPermissions: args['skip-permissions'],
        timeoutMs,
      }),
    );

    let result: DriveResult;
    try {
      result = await runDrive(host, deps, config);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(RUNTIME_ERROR_EXIT);
    }

    const disposed = result.state.items.filter((i) => i.exit !== null).length;
    const open = result.state.items.length - disposed;

    if (format === 'json') {
      writeJson({
        work_item_id: workItemId,
        outcome: result.outcome,
        rounds: result.rounds,
        reasons: result.reasons,
        disposed,
        open,
        items: result.state.items,
        efficacy: result.efficacy,
      });
    } else {
      writeHuman(`drive ${workItemId}: ${result.outcome} (${result.rounds} rounds)`);
      writeHuman(`  items: ${disposed} disposed / ${open} open`);
      for (const reason of result.reasons) writeHuman(`  reason: ${reason}`);
    }

    // Non-drained terminal states (parked / ceiling / oracle-violation / timeout)
    // are failures — the queue did not reach fixpoint under a verified completion.
    if (result.outcome !== 'drained') process.exit(RUNTIME_ERROR_EXIT);
  },
});
