import { defineCommand } from 'citty';
import { productionAttemptPush, productionDriveMember } from '~/core/chain-drive';
import { resolveRepoRootForCreate } from '~/core/fs';
import { IntentStore } from '~/core/intent-store';
import { WorkItemStore } from '~/core/work-item-store';
import {
  createWorktreeForWorkItem,
  listWorktreesForWorkspace,
  mergeWorktreesForWorkItem,
  removeWorktreesForWorkItem,
  worktreeBindingHint,
} from '~/core/worktree';
import { DEFAULT_MAX_DEPTH, driveWorktrees } from '~/core/worktree-drive';
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
        const state = r.orphan
          ? `ORPHAN${r.dirty ? ' dirty' : ''}`
          : r.exists
            ? `${r.dirty ? 'dirty' : 'clean'} +${r.ahead}/-${r.behind} (vs ${r.base})`
            : 'MISSING';
        const workItem = r.orphan ? 'orphan' : r.work_item_id;
        const repoCol = r.owning_repo === '' ? '—' : r.owning_repo;
        writeHuman(`${workItem}\t${repoCol}\t${r.branch}\t${state}\t${r.worktree_path}`);
      }
    } catch (err) {
      writeError(`worktree list failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const worktreeDrive = defineCommand({
  meta: {
    name: 'drive',
    description:
      'Drive an INDEPENDENT set of named work items, each in its own DITTO worktree: drive each non-terminal intent-locked member through its autopilot inside its worktree, then clean-merge it back into its owning repo and tear the worktree down. Unlike `work chain drive`, the set is not a follows-spine — a halt on one member CONTINUES to the next; only the depth cap breaks the run. Skips done members (idempotent resume), halts (with a per-member verdict) on a missing intent.json, an abandoned member, or a member that ends not-done. Reports push-readiness on full completion; pushes ONLY with --push (never unasked, never force). This is the sanctioned explicit carve-out: only the named ids are driven (no auto-discovery).',
  },
  args: {
    workIds: {
      type: 'positional',
      description: 'Work item ids to drive (each in its own worktree)',
      required: true,
    },
    push: {
      type: 'boolean',
      description:
        'On a fully driven-done set, push the current branch HEAD to origin (no force; any push failure degrades to skipped, exit 0). Default: report push-readiness without pushing.',
      default: false,
    },
    'max-depth': {
      type: 'string',
      description: `Max members driven per invocation (stop-at-cap with a report; default ${DEFAULT_MAX_DEPTH})`,
      required: false,
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
    // INPUT (security): validate every id shape BEFORE any path/subprocess use — the
    // store trusts its caller and localDir does a bare join, so a malformed/`../` id
    // must be rejected at the entry. `args._` holds the full variadic positional set.
    const rawIds = (args._ ?? []).map((v) => String(v));
    if (rawIds.length === 0) {
      writeError('worktree drive: at least one work item id is required');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const workIds = rawIds.map((id) => parseWorkId(id));
    let maxDepth = DEFAULT_MAX_DEPTH;
    if (args['max-depth'] !== undefined) {
      const raw = String(args['max-depth']).trim();
      if (!/^\d+$/.test(raw) || Number(raw) < 1) {
        writeError(`--max-depth must be a positive integer; got "${args['max-depth']}"`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      maxDepth = Number(raw);
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new WorkItemStore(repoRoot);
    const intentStore = new IntentStore(repoRoot);
    try {
      const result = await driveWorktrees(
        {
          store,
          intentExists: (id) => intentStore.exists(id),
          driveMember: (worktreeCwd, wiId) => productionDriveMember(worktreeCwd, wiId),
          merge: (root, wiId) => mergeWorktreesForWorkItem(root, wiId),
          removeWorktrees: (root, wiId) => removeWorktreesForWorkItem(root, wiId),
          attemptPush: (members) => productionAttemptPush(repoRoot, members),
        },
        { workIds, push: args.push === true, maxDepth },
      );
      if (format === 'json') {
        writeJson(result);
      } else {
        writeHuman(`Worktree drive (${result.work_ids.length} member(s)):`);
        for (const e of result.ledger) {
          const removed = e.disposition === 'driven-done' ? ` removed=${e.removed === true}` : '';
          writeHuman(
            `  ${e.member_id}\t${e.disposition}${removed}${e.reason ? `\t(${e.reason})` : ''}`,
          );
        }
        if (result.halted_members.length > 0)
          writeHuman(`  halted_members: ${result.halted_members.join(', ')}`);
        if (result.stopped_at_cap)
          writeHuman(`  stopped at depth cap (${maxDepth}) — re-invoke to continue`);
        writeHuman(`  all_driven_done: ${result.all_driven_done}`);
        writeHuman(`  push_ready: ${result.push_ready}`);
        writeHuman(`  push: ${result.push}`);
      }
    } catch (err) {
      writeError(`worktree drive failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const worktreeCommand = defineCommand({
  meta: {
    name: 'worktree',
    description: 'Manage per-work-item git worktrees (list, create, remove, drive)',
  },
  subCommands: {
    list: worktreeList,
    create: worktreeCreate,
    remove: worktreeRemove,
    drive: worktreeDrive,
  },
});
