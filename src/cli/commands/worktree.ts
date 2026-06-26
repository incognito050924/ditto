import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import { WorkItemStore } from '~/core/work-item-store';
import {
  createWorktreeForWorkItem,
  listWorktreesForWorkspace,
  removeWorktreesForWorkItem,
  worktreeBindingHint,
} from '~/core/worktree';
import { workItemId as workItemIdSchema } from '~/schemas/common';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

function parseWorkId(value: string): string {
  const parsed = workItemIdSchema.safeParse(value);
  if (!parsed.success) {
    writeError(`invalid work item id "${value}": ${parsed.error.issues[0]?.message ?? 'bad id'}`);
    process.exit(USAGE_ERROR_EXIT);
  }
  return parsed.data;
}

const worktreeCreate = defineCommand({
  meta: {
    name: 'create',
    description:
      'Create the work item branch+worktree(s) (.ditto/local/worktrees/<wi> on ditto/<wi>); multi-repo nests one per sub-repo',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id to create a worktree for',
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
    const workId = parseWorkId(args.workId);
    const repoRoot = await resolveRepoRootForCreate();
    const store = new WorkItemStore(repoRoot);
    try {
      if (!(await store.exists(workId))) {
        writeError(`work item ${workId} not found — create it first with \`ditto work start\``);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const worktrees = await createWorktreeForWorkItem(repoRoot, workId);
      if (format === 'json') {
        writeJson({ work_item_id: workId, worktrees });
      } else {
        writeHuman(`Created ${worktrees.length} worktree(s) for ${workId}:`);
        for (const wt of worktrees) {
          writeHuman(`  ${wt.owning_repo}\t${wt.branch}\t${wt.worktree_path}`);
        }
        const hint = worktreeBindingHint(repoRoot, worktrees, workId);
        if (hint) writeHuman(hint);
      }
    } catch (err) {
      writeError(`worktree create failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const worktreeRemove = defineCommand({
  meta: {
    name: 'remove',
    description:
      'Tear down a work item worktree(s). Dirty/unmerged worktrees are blocked unless --force (explicit approval)',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id whose worktree(s) to remove',
      required: true,
    },
    force: {
      type: 'boolean',
      description: 'Explicit approval: remove even dirty/unmerged worktrees (-f / -D)',
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
      return;
    }
    const workId = parseWorkId(args.workId);
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const result = await removeWorktreesForWorkItem(repoRoot, workId, { force: args.force });
      if (format === 'json') {
        writeJson({ work_item_id: workId, removed: result.removed, blocked: result.blocked });
      } else {
        writeHuman(`Removed ${result.removed.length} worktree(s) for ${workId}.`);
        for (const wt of result.removed)
          writeHuman(`  removed  ${wt.owning_repo}\t${wt.worktree_path}`);
        for (const b of result.blocked) {
          writeHuman(
            `  BLOCKED  ${b.worktree.owning_repo}\t${b.worktree.worktree_path}: ${b.reason}`,
          );
        }
        if (result.blocked.length > 0) {
          writeHuman('Re-run with --force to remove blocked worktrees (this discards their work).');
        }
      }
      // Blocked-but-not-force is an intentional safety refusal, not a crash → exit 0.
    } catch (err) {
      writeError(`worktree remove failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const worktreeList = defineCommand({
  meta: {
    name: 'list',
    description:
      'List per-work-item worktrees across the workspace with their git state (dirty, ahead/behind base)',
  },
  args: {
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
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const rows = await listWorktreesForWorkspace(repoRoot);
      if (format === 'json') {
        writeJson({ worktrees: rows });
        return;
      }
      if (rows.length === 0) {
        writeHuman('No worktrees. Create one with: ditto worktree create <work-item-id>');
        return;
      }
      writeHuman('work-item\trepo\tbranch\tstate\tpath');
      for (const r of rows) {
        const state = r.exists
          ? `${r.dirty ? 'dirty' : 'clean'} +${r.ahead}/-${r.behind} (vs ${r.base})`
          : 'MISSING';
        writeHuman(
          `${r.work_item_id}\t${r.owning_repo}\t${r.branch}\t${state}\t${r.worktree_path}`,
        );
      }
    } catch (err) {
      writeError(`worktree list failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const worktreeCommand = defineCommand({
  meta: {
    name: 'worktree',
    description: 'Manage per-work-item git worktrees (list, create, remove)',
  },
  subCommands: {
    list: worktreeList,
    create: worktreeCreate,
    remove: worktreeRemove,
  },
});
