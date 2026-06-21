import { isAbsolute, join } from 'node:path';
import { defineCommand } from 'citty';
import { scanCandidates } from '~/core/cleanup-scan';
import {
  CleanupBasisRequiredError,
  CleanupProtectedPathError,
  CleanupStore,
} from '~/core/cleanup-store';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  type CleanupRunParams,
  cleanupAction,
  cleanupBasisSignal,
  cleanupRunParams,
  cleanupTrackedFilter,
} from '~/schemas/cleanup-index';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto classify` — deterministic mechanics for the doc-cleanup classify pipeline.
 * Per ADR-0001 this CLI never judges a doc with an LLM: it discovers
 * candidates + deterministic signals (`scan`), creates the run (`create-run`), and
 * stages ONE already-decided doc into an action bucket (`stage`, delegating to
 * CleanupStore). The per-doc DECISION (which bucket + basis, incl. the
 * judgment-only `contradiction` signal) is made by a fresh subagent per doc in
 * skills/classify/SKILL.md (ac-8), then handed back to `stage`.
 */

/**
 * Fail-closed auto-cleanup guard (ac-6). On the auto/autopilot path, the run may
 * only ARCHIVE — never delete. `delete-candidate` is structurally excluded here so
 * no auto path can ever delete, regardless of caller. The non-delete buckets are
 * the archive targets the auto chain hands to the 정리/cleanup
 * command. `unclassified` is also kept off the auto chain — auto-archive only
 * touches docs an agent affirmatively bucketed.
 */
const AUTO_ARCHIVE_ACTIONS = ['quarantine', 'absorb-then-discard'] as const;
export type AutoArchiveAction = (typeof AUTO_ARCHIVE_ACTIONS)[number];

export class AutoCleanupDeleteRefusedError extends Error {
  constructor(action: string) {
    super(
      `auto-cleanup path refuses action "${action}": auto/autopilot runs can only archive, never delete (ac-6 fail-closed)`,
    );
    this.name = 'AutoCleanupDeleteRefusedError';
  }
}

/**
 * Resolve the archive action for the auto-cleanup chain. Throws unless `action`
 * is one of the archive buckets — this is the real, tested fail-closed guard that
 * makes the auto path structurally incapable of delete (ac-6).
 *
 * The auto chain hands the run to the cleanup command's ARCHIVE-ONLY
 * entry point `autoChainArchive` (src/core/cleanup-archive.ts), which physically
 * calls `archiveRun` and cannot reach `deleteRun`. Per-stage this guard already
 * rejects any non-archive bucket before a file is touched; the run-level chain
 * below then archives the staged folder. There is no auto path to delete.
 */
export function autoChainArchiveAction(action: string): AutoArchiveAction {
  if ((AUTO_ARCHIVE_ACTIONS as readonly string[]).includes(action)) {
    return action as AutoArchiveAction;
  }
  throw new AutoCleanupDeleteRefusedError(action);
}

/**
 * Run-level auto-cleanup chain (ac-6): after the auto path has staged its
 * archive-bucket entries into `runId`, hand the WHOLE run folder to the cleanup
 * command's archive-only entry point. This is the wired call site — it routes
 * to `autoChainArchive` (archive == zip + keep, reversible), never to delete.
 */
export async function runAutoCleanupChain(repoRoot: string, runId: string): Promise<string> {
  const { autoChainArchive } = await import('~/core/cleanup-archive');
  const result = await autoChainArchive(repoRoot, runId);
  return result.zip_path;
}

function parseFormatOrExit(output: string): ReturnType<typeof parseOutputFormat> {
  try {
    return parseOutputFormat(output);
  } catch (err) {
    writeError(err instanceof Error ? err.message : String(err));
    process.exit(USAGE_ERROR_EXIT);
  }
}

const DEFAULT_CATEGORIES = ['design', 'report', 'note', 'scratch'] as const;

function parseListArg(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseAggressivenessOrExit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    writeError(`--aggressiveness/적극성 must be an integer 1..5; got "${value}"`);
    process.exit(USAGE_ERROR_EXIT);
  }
  return n;
}

function parseConcurrencyOrExit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    writeError(`--concurrency/동시성 must be a positive integer; got "${value}"`);
    process.exit(USAGE_ERROR_EXIT);
  }
  return n;
}

function parseTrackedOrExit(value: string): CleanupRunParams['tracked_filter'] {
  const parsed = cleanupTrackedFilter.safeParse(value);
  if (!parsed.success) {
    writeError(
      `--tracked must be one of ${cleanupTrackedFilter.options.join('|')}; got "${value}"`,
    );
    process.exit(USAGE_ERROR_EXIT);
  }
  return parsed.data;
}

/** A scope string is treated as a commit list when every token is a hex sha. */
function scopeIsCommits(scope: string): boolean {
  const tokens = scope
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return tokens.length > 0 && tokens.every((t) => /^[0-9a-f]{7,40}$/i.test(t));
}

const classifyScan = defineCommand({
  meta: {
    name: 'scan',
    description:
      'Discover candidate docs across the workspace with deterministic lost-authority signals (orphan/stale). Excludes the protected set (ac-4); resolves each doc owning sub-repo (ac-7). The contradiction signal needs judgment → per-doc agent in the skill, not here.',
  },
  args: {
    scope: {
      type: 'string',
      description:
        '범위 — gitignore-form glob OR a comma-separated commit-hash list to limit scope',
      required: false,
    },
    tracked: {
      type: 'string',
      description: `Tracked filter: ${cleanupTrackedFilter.options.join('|')} (default tracked-only)`,
      default: 'tracked-only',
    },
    categories: {
      type: 'string',
      description: '분류유형 — comma-separated doc categories (default all four)',
      required: false,
    },
    aggressiveness: {
      type: 'string',
      description: '적극성 — 1 (conservative) … 5 (aggressive); default 3',
      default: '3',
    },
    concurrency: {
      type: 'string',
      description: '동시성 — worker count the skill fans out at (default 4)',
      default: '4',
    },
    'auto-cleanup': {
      type: 'boolean',
      description:
        '자동정리 — chain into the archive-only cleanup path after classification (default off; delete never runs on this path, ac-6)',
      default: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    const format = parseFormatOrExit(args.output);
    const trackedFilter = parseTrackedOrExit(args.tracked);
    const aggressiveness = parseAggressivenessOrExit(args.aggressiveness);
    const concurrency = parseConcurrencyOrExit(args.concurrency);
    const categories =
      args.categories === undefined ? [...DEFAULT_CATEGORIES] : parseListArg(args.categories);

    const scope = args.scope;
    const scopeCommits =
      scope && scopeIsCommits(scope) ? scope.split(',').map((s) => s.trim()) : undefined;
    const scopeGlob = scope && !scopeCommits ? scope : undefined;

    const repoRoot = await resolveRepoRootForCreate();
    try {
      const result = await scanCandidates(repoRoot, {
        trackedFilter,
        aggressiveness,
        ...(scopeGlob ? { scopeGlob } : {}),
        ...(scopeCommits ? { scopeCommits } : {}),
        categories,
      });
      const params = {
        tracked_filter: trackedFilter,
        categories,
        auto_cleanup: args['auto-cleanup'],
        concurrency,
        aggressiveness,
        ...(scope ? { scope } : {}),
      };
      if (format === 'json') {
        writeJson({ params, ...result });
      } else {
        writeHuman(`Scanned ${repoRoot}`);
        writeHuman(`  candidates: ${result.candidates.length}`);
        writeHuman(`  excluded (protected): ${result.excluded_protected.length}`);
        writeHuman(`  tracked filter: ${trackedFilter}  aggressiveness: ${aggressiveness}`);
        if (args['auto-cleanup']) {
          writeHuman('  auto-cleanup: ON (archive-only — delete never runs, ac-6)');
        }
        for (const c of result.candidates) {
          const sig = c.signals.map((s) => s.kind).join(',') || '-';
          writeHuman(
            `  ${c.tracked ? 'T' : 'U'} ${c.path}\t[${sig}]\trepo=${c.owning_repo ?? '.'}`,
          );
        }
      }
    } catch (err) {
      writeError(`classify scan failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const classifyCreateRun = defineCommand({
  meta: {
    name: 'create-run',
    description:
      'Create a classify run folder (auto id) with 4 action subfolders + a params snapshot',
  },
  args: {
    params: {
      type: 'string',
      description: 'JSON snapshot of cleanupRunParams (the scan params this run was invoked with)',
      required: true,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    const format = parseFormatOrExit(args.output);
    let raw: unknown;
    try {
      raw = JSON.parse(args.params);
    } catch (err) {
      writeError(`--params is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const parsed = cleanupRunParams.safeParse(raw);
    if (!parsed.success) {
      writeError('--params failed schema validation:');
      for (const issue of parsed.error.issues) {
        writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const store = new CleanupStore(repoRoot);
      const runId = await store.createRun(parsed.data);
      if (format === 'json') {
        writeJson({ run_id: runId, run_dir: store.runDir(runId) });
      } else {
        writeHuman(`Created run ${runId}`);
        writeHuman(`  dir: ${store.runDir(runId)}`);
      }
    } catch (err) {
      writeError(`classify create-run failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const classifyStage = defineCommand({
  meta: {
    name: 'stage',
    description:
      'Stage ONE already-decided doc into an action bucket with its basis (>=1 signal). Delegates to CleanupStore.stageDoc; inherits protected (ac-4) and empty-basis (ac-5) refusal. The skill calls this once per doc with the agent decision. With --auto, the auto-cleanup fail-closed guard refuses delete (ac-6).',
  },
  args: {
    'run-id': { type: 'string', description: 'Target run id (from create-run)', required: true },
    path: {
      type: 'string',
      description: 'Doc to stage (absolute, or repo-relative to the workspace root)',
      required: true,
    },
    action: {
      type: 'string',
      description: `Disposition: ${cleanupAction.options.join('|')}`,
      required: true,
    },
    summary: { type: 'string', description: 'Short rationale for the disposition', default: '' },
    basis: {
      type: 'string',
      description:
        'JSON array of basis signals [{kind:orphan|stale|contradiction, detail}]; at least one (ac-5)',
      required: true,
    },
    aggressiveness: {
      type: 'string',
      description: '적극성 the decision was made at (1..5)',
      default: '3',
    },
    agent: {
      type: 'string',
      description: 'Agent/handle that classified this doc',
      required: false,
    },
    auto: {
      type: 'boolean',
      description:
        'Auto-cleanup path: enforce archive-only — refuse delete-candidate/unclassified (ac-6 fail-closed)',
      default: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    const format = parseFormatOrExit(args.output);
    const aggressiveness = parseAggressivenessOrExit(args.aggressiveness);
    const actionParsed = cleanupAction.safeParse(args.action);
    if (!actionParsed.success) {
      writeError(
        `--action must be one of ${cleanupAction.options.join('|')}; got "${args.action}"`,
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    let basisRaw: unknown;
    try {
      basisRaw = JSON.parse(args.basis);
    } catch (err) {
      writeError(`--basis is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const basisParsed = cleanupBasisSignal.array().safeParse(basisRaw);
    if (!basisParsed.success) {
      writeError('--basis failed schema validation:');
      for (const issue of basisParsed.error.issues) {
        writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(USAGE_ERROR_EXIT);
      return;
    }

    // ac-6 fail-closed: on the auto/autopilot path, refuse any non-archive action
    // BEFORE touching the filesystem. The auto path is structurally archive-only.
    if (args.auto) {
      try {
        autoChainArchiveAction(actionParsed.data);
      } catch (err) {
        writeError(err instanceof Error ? err.message : String(err));
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
    }

    const repoRoot = await resolveRepoRootForCreate();
    const absPath = isAbsolute(args.path) ? args.path : join(repoRoot, args.path);
    try {
      const store = new CleanupStore(repoRoot);
      const entry = await store.stageDoc(args['run-id'], {
        absPath,
        action: actionParsed.data,
        summary: args.summary,
        basis: basisParsed.data,
        aggressiveness,
        ...(args.agent ? { agent: args.agent } : {}),
      });
      if (format === 'json') {
        writeJson(entry);
      } else {
        writeHuman(`Staged ${entry.original_path} → ${entry.action}`);
        writeHuman(`  staged_path: ${entry.staged_path}`);
        writeHuman(`  basis: ${entry.basis.map((b) => b.kind).join(',')}`);
      }
    } catch (err) {
      if (err instanceof CleanupProtectedPathError || err instanceof CleanupBasisRequiredError) {
        writeError(err.message);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      writeError(`classify stage failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const classifyStatus = defineCommand({
  meta: {
    name: 'status',
    description: 'Read the index of a classify run (run metadata + per-doc entries)',
  },
  args: {
    'run-id': { type: 'string', description: 'Run id to read', required: true },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    const format = parseFormatOrExit(args.output);
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const store = new CleanupStore(repoRoot);
      const idx = await store.readIndex(args['run-id']);
      if (format === 'json') {
        writeJson(idx);
      } else {
        writeHuman(`Run ${idx.run_id} (${idx.created_at})`);
        writeHuman(`  entries: ${idx.entries.length}`);
        for (const e of idx.entries) {
          writeHuman(
            `  ${e.action}\t${e.original_path}\t[${e.basis.map((b) => b.kind).join(',')}]`,
          );
        }
      }
    } catch (err) {
      writeError(`classify status failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const classifyCommand = defineCommand({
  meta: {
    name: 'classify',
    description:
      'Doc-cleanup classification mechanics (ADR-0001 thin CLI behind skills/classify): scan candidates + deterministic signals, create a run, stage one decided doc. The per-doc judgment is the skill agents job.',
  },
  subCommands: {
    scan: classifyScan,
    'create-run': classifyCreateRun,
    stage: classifyStage,
    status: classifyStatus,
  },
});
