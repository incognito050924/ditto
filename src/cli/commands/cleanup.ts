import { defineCommand } from 'citty';
import {
  CleanupDeleteRefusedError,
  CleanupDirtyRepoError,
  CleanupRunMissingError,
  archiveRun,
  commitCleanup,
  deleteRun,
  restoreDoc,
} from '~/core/cleanup-archive';
import { CleanupStore } from '~/core/cleanup-store';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto cleanup` — terminal mechanics for a classify run folder (ADR-0001:
 * pure git/zip/fs, no LLM). Acts ONLY on the named run id's folder:
 *
 *  - `archive` (default): zip the folder, keep the zip (reversible), remove it.
 *  - `delete`: permanent removal, gated behind an explicit confirm; auto/autopilot
 *    refuses without one (fail-closed, ac-6).
 *  - `restore`: move one staged doc back to its original path (store passthrough).
 *
 * `--commit` commits the result PER affected sub-repo (one each, git-revertable),
 * aborting if any sub-repo working tree is dirty beyond this cleanup (ac-10).
 */

function parseFormatOrExit(output: string): ReturnType<typeof parseOutputFormat> {
  try {
    return parseOutputFormat(output);
  } catch (err) {
    writeError(err instanceof Error ? err.message : String(err));
    process.exit(USAGE_ERROR_EXIT);
  }
}

const COMMIT_MESSAGE = 'chore(cleanup): remove staged docs from classify run';

const cleanupArchive = defineCommand({
  meta: {
    name: 'archive',
    description:
      'Zip a run folder to .ditto/local/cleanup/archive/<run-id>.zip (reversible — zip kept), then remove the folder. Optionally --commit the removals per sub-repo.',
  },
  args: {
    'run-id': {
      type: 'string',
      description: '작업ID/run id (from classify create-run)',
      required: false,
    },
    작업ID: { type: 'string', description: 'Alias of --run-id', required: false },
    workItem: {
      type: 'string',
      description: 'Work item the run belongs to (informational)',
      required: false,
    },
    commit: {
      type: 'boolean',
      description:
        'After archiving, commit the removals per affected sub-repo (git-revertable). Aborts if a sub-repo is dirty.',
      default: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    const format = parseFormatOrExit(args.output);
    const runId = args['run-id'] ?? args.작업ID;
    if (!runId) {
      writeError('--run-id (or --작업ID) is required');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new CleanupStore(repoRoot);
    try {
      // Read the index BEFORE archiving removes the folder (needed for --commit).
      const index = args.commit ? await store.readIndex(runId) : null;
      const result = await archiveRun(repoRoot, runId);
      const commit = index ? commitCleanup(repoRoot, index, COMMIT_MESSAGE) : null;
      if (format === 'json') {
        writeJson({ action: 'archive', ...result, ...(commit ? { commit } : {}) });
      } else {
        writeHuman(`Archived ${runId} → ${result.zip_path}`);
        writeHuman(`  removed run folder: ${result.removed_run_dir}`);
        if (commit) {
          for (const c of commit.commits) {
            writeHuman(`  committed ${c.repo}: ${c.sha} (${c.paths.length} path(s))`);
          }
        }
      }
    } catch (err) {
      exitForCleanupError(err, 'archive');
    }
  },
});

const cleanupDelete = defineCommand({
  meta: {
    name: 'delete',
    description:
      'PERMANENTLY remove a run folder + staged files (irreversible). Requires --confirm; auto/autopilot refuses without it (fail-closed, ac-6). Optionally --commit removals per sub-repo.',
  },
  args: {
    'run-id': { type: 'string', description: '작업ID/run id', required: false },
    작업ID: { type: 'string', description: 'Alias of --run-id', required: false },
    workItem: {
      type: 'string',
      description: 'Work item the run belongs to (informational)',
      required: false,
    },
    confirm: {
      type: 'boolean',
      description: 'Explicit operator confirm for the irreversible delete. Without it: refused.',
      default: false,
    },
    commit: {
      type: 'boolean',
      description:
        'After deleting, commit the removals per affected sub-repo. Aborts if a sub-repo is dirty.',
      default: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    const format = parseFormatOrExit(args.output);
    const runId = args['run-id'] ?? args.작업ID;
    if (!runId) {
      writeError('--run-id (or --작업ID) is required');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new CleanupStore(repoRoot);
    try {
      const index = args.commit ? await store.readIndex(runId) : null;
      const result = await deleteRun(repoRoot, runId, args.confirm);
      const commit = index ? commitCleanup(repoRoot, index, COMMIT_MESSAGE) : null;
      if (format === 'json') {
        writeJson({ action: 'delete', ...result, ...(commit ? { commit } : {}) });
      } else {
        writeHuman(`Deleted ${runId} (permanent)`);
        writeHuman(`  removed run folder: ${result.removed_run_dir}`);
        if (commit) {
          for (const c of commit.commits) {
            writeHuman(`  committed ${c.repo}: ${c.sha} (${c.paths.length} path(s))`);
          }
        }
      }
    } catch (err) {
      exitForCleanupError(err, 'delete');
    }
  },
});

const cleanupRestore = defineCommand({
  meta: {
    name: 'restore',
    description: 'Move one staged doc back to its original path (store restore passthrough).',
  },
  args: {
    'run-id': { type: 'string', description: '작업ID/run id', required: false },
    작업ID: { type: 'string', description: 'Alias of --run-id', required: false },
    path: {
      type: 'string',
      description: 'original_path of the staged doc to restore',
      required: true,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    const format = parseFormatOrExit(args.output);
    const runId = args['run-id'] ?? args.작업ID;
    if (!runId) {
      writeError('--run-id (or --작업ID) is required');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const result = await restoreDoc(repoRoot, runId, args.path);
      if (format === 'json') {
        writeJson({ action: 'restore', ...result });
      } else {
        writeHuman(`Restored ${result.original_path} from ${runId}`);
      }
    } catch (err) {
      exitForCleanupError(err, 'restore');
    }
  },
});

function exitForCleanupError(err: unknown, op: string): never {
  if (err instanceof CleanupRunMissingError) {
    writeError(err.message);
    process.exit(USAGE_ERROR_EXIT);
  }
  if (err instanceof CleanupDeleteRefusedError) {
    writeError(err.message);
    process.exit(USAGE_ERROR_EXIT);
  }
  if (err instanceof CleanupDirtyRepoError) {
    writeError(err.message);
    process.exit(RUNTIME_ERROR_EXIT);
  }
  writeError(`cleanup ${op} failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(RUNTIME_ERROR_EXIT);
}

export const cleanupCommand = defineCommand({
  meta: {
    name: 'cleanup',
    description:
      'Terminal mechanics for a classify run folder: archive (default, reversible), delete (gated/fail-closed), restore. --commit makes per-sub-repo, git-revertable commits.',
  },
  subCommands: {
    archive: cleanupArchive,
    delete: cleanupDelete,
    restore: cleanupRestore,
  },
});
