import { defineCommand } from 'citty';
import { PLACEHOLDER_AC_STATEMENT } from '~/core/charter';
import { CompletionStore } from '~/core/completion-store';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  InvalidBaseRefError,
  InvalidHeadRefError,
  writeWorkItemHandoff,
} from '~/core/work-item-handoff';
import { WorkItemStore } from '~/core/work-item-store';
import { declarerRole } from '~/schemas/common';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

const workStart = defineCommand({
  meta: {
    name: 'start',
    description: 'Create a new work item from a request and initial goal',
  },
  args: {
    goal: {
      type: 'positional',
      description: 'Observable outcome stated in project terms',
      required: true,
    },
    request: {
      type: 'string',
      description: 'Verbatim user request that produced this work item',
      required: true,
    },
    title: {
      type: 'string',
      description: 'Short title; defaults to goal truncated',
      required: false,
    },
    profile: {
      type: 'string',
      description: 'Owner profile: read-only|workspace-write|networked|reviewer|isolated',
      default: 'workspace-write',
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
    const repoRoot = await resolveRepoRootForCreate();
    const store = new WorkItemStore(repoRoot);
    const profile = args.profile as
      | 'read-only'
      | 'workspace-write'
      | 'networked'
      | 'reviewer'
      | 'isolated';
    const title = args.title ?? args.goal.slice(0, 80);
    try {
      const created = await store.create({
        title,
        source_request: args.request,
        goal: args.goal,
        owner_profile: profile,
        acceptance_criteria: [
          {
            id: 'ac-1',
            // Single source of truth (V1): the placeholder detector in
            // user-prompt-submit matches this exact string to fire the
            // deep-interview directive, so the CLI must emit the same constant
            // rather than a hand-written sibling that silently bypasses it.
            statement: PLACEHOLDER_AC_STATEMENT,
            verdict: 'unverified',
            evidence: [],
          },
        ],
      });
      if (format === 'json') {
        writeJson({
          work_item_id: created.id,
          path: `.ditto/local/work-items/${created.id}/work-item.json`,
          status: created.status,
          repo_root: repoRoot,
        });
      } else {
        writeHuman(`Created work item ${created.id}`);
        writeHuman(`  goal: ${created.goal}`);
        writeHuman(`  status: ${created.status}`);
        writeHuman(`  path: ${repoRoot}/.ditto/local/work-items/${created.id}/work-item.json`);
        writeHuman('Next steps:');
        writeHuman(
          '  1. /ditto:deep-interview (or: ditto deep-interview start → record-turn → check-readiness → finalize) — writes intent.json',
        );
        writeHuman(
          `  2. ditto autopilot bootstrap --workItem ${created.id} (requires intent.json from finalize)`,
        );
      }
    } catch (err) {
      writeError(`work start failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const workStatus = defineCommand({
  meta: {
    name: 'status',
    description: 'Show current state of one or all work items',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id; if omitted, lists all work items',
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
    let repoRoot: string;
    try {
      repoRoot = await resolveRepoRootForCreate();
    } catch (err) {
      writeError(`cannot find repo root: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const store = new WorkItemStore(repoRoot);
    if (!args.workId) {
      const list = await store.list();
      if (format === 'json') {
        writeJson({ items: list });
      } else if (list.length === 0) {
        writeHuman('No work items.');
      } else {
        for (const s of list) {
          writeHuman(`${s.id}\t${s.status}\t${s.updated_at}\t${s.title}`);
        }
      }
      return;
    }
    try {
      const item = await store.get(args.workId);
      if (format === 'json') {
        writeJson(item);
      } else {
        writeHuman(`id:     ${item.id}`);
        writeHuman(`title:  ${item.title}`);
        writeHuman(`status: ${item.status}`);
        writeHuman(`goal:   ${item.goal}`);
        writeHuman(`updated_at: ${item.updated_at}`);
        writeHuman('acceptance:');
        for (const ac of item.acceptance_criteria) {
          writeHuman(`  - ${ac.id} [${ac.verdict}] ${ac.statement}`);
        }
      }
    } catch (err) {
      writeError(`work status failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workHandoff = defineCommand({
  meta: {
    name: 'handoff',
    description: 'Generate or refresh the handoff document for a work item',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id to hand off',
      required: true,
    },
    base: {
      type: 'string',
      description:
        'Git ref to diff against when collecting changed_files. Default tries started_at_sha, origin/main, origin/master, main, master.',
      required: false,
    },
    head: {
      type: 'string',
      description:
        'Git ref to diff up to when collecting changed_files. Default HEAD. Useful for correcting past handoffs (base...head frozen range).',
      required: false,
    },
    'declared-by': {
      type: 'string',
      description:
        'Agent role that declares this completion (who judged): main|planner|implementer|verifier|reviewer|researcher|synthesizer. Default main.',
      default: 'main',
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
    const declaredBy = declarerRole.safeParse(args['declared-by']);
    if (!declaredBy.success) {
      writeError(
        `--declared-by must be one of ${declarerRole.options.join('|')}; got "${args['declared-by']}"`,
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new WorkItemStore(repoRoot);
    try {
      let result: Awaited<ReturnType<typeof writeWorkItemHandoff>>;
      try {
        result = await writeWorkItemHandoff(repoRoot, store, args.workId, {
          ...(args.base ? { base: args.base } : {}),
          ...(args.head ? { head: args.head } : {}),
          declaredBy: declaredBy.data,
        });
      } catch (err) {
        if (err instanceof InvalidBaseRefError || err instanceof InvalidHeadRefError) {
          writeError(err.message);
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        throw err;
      }
      if (format === 'json') {
        writeJson({
          work_item_id: args.workId,
          final_verdict: result.completion.final_verdict,
          handoff_path: result.handoffPath,
          completion_path: result.completionPath,
          base_used: result.baseUsed,
          changed_files: result.collectedChangedFiles,
        });
      } else {
        writeHuman(`Handoff for ${args.workId}`);
        writeHuman(`  final_verdict:  ${result.completion.final_verdict}`);
        writeHuman(`  base_used:      ${result.baseUsed ?? '(none)'}`);
        writeHuman(`  changed_files:  ${result.collectedChangedFiles.length}`);
        writeHuman(`  handoff:        ${result.handoffPath}`);
        writeHuman(`  completion.json: ${result.completionPath}`);
      }
    } catch (err) {
      writeError(`work handoff failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const TERMINAL_STATUSES = ['done', 'abandoned'] as const;

const workAbandon = defineCommand({
  meta: {
    name: 'abandon',
    description: 'Close a work item as abandoned (give up; no evidence required)',
  },
  args: {
    workId: { type: 'positional', description: 'Work item id to abandon', required: true },
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
    const store = new WorkItemStore(repoRoot);
    try {
      const cur = await store.get(args.workId);
      if (cur.status === 'done' || cur.status === 'abandoned') {
        writeError(`work ${args.workId} is already terminal (status=${cur.status})`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const closed = await store.close(args.workId, 'abandoned');
      if (format === 'json') {
        writeJson({ id: closed.id, status: closed.status, closed_at: closed.closed_at });
      } else {
        writeHuman(
          `Abandoned ${closed.id} (was ${cur.status}). Archive with: ditto work archive <label>`,
        );
      }
    } catch (err) {
      writeError(`work abandon failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workDone = defineCommand({
  meta: {
    name: 'done',
    description:
      'Mark a work item done — only when its completion final_verdict=pass (evidence gate)',
  },
  args: {
    workId: { type: 'positional', description: 'Work item id to mark done', required: true },
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
    const store = new WorkItemStore(repoRoot);
    const completions = new CompletionStore(repoRoot);
    try {
      await store.get(args.workId); // throws with a clear error if unknown
      // Evidence gate: done requires a completion contract with final_verdict=pass.
      // Manual `done` syncs status to a verified completion; it never bypasses it.
      if (!(await completions.exists(args.workId))) {
        writeError(
          `work ${args.workId} has no completion.json — run \`ditto verify\` first, or \`ditto work abandon\` to give up`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const completion = await completions.get(args.workId);
      if (completion.final_verdict !== 'pass') {
        writeError(
          `work ${args.workId} completion final_verdict=${completion.final_verdict} (not pass) — cannot mark done`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const closed = await store.close(args.workId, 'done');
      if (format === 'json') {
        writeJson({ id: closed.id, status: closed.status, closed_at: closed.closed_at });
      } else {
        writeHuman(
          `Done ${closed.id} (completion final_verdict=pass). Archive with: ditto work archive <label>`,
        );
      }
    } catch (err) {
      writeError(`work done failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workArchive = defineCommand({
  meta: {
    name: 'archive',
    description:
      'Move terminal (done/abandoned) work items to .ditto/local/archive/<label> (ADR-0005 D3)',
  },
  args: {
    label: {
      type: 'positional',
      description: 'Archive label / batch name (e.g. 2026-Q2). [A-Za-z0-9._-]+',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'List what would move without moving',
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
    const repoRoot = await resolveRepoRootForCreate();
    const store = new WorkItemStore(repoRoot);
    try {
      if (args['dry-run']) {
        const candidates = (await store.list()).filter((s) =>
          (TERMINAL_STATUSES as readonly string[]).includes(s.status),
        );
        if (format === 'json') {
          writeJson({
            dry_run: true,
            label: args.label,
            would_archive: candidates.map((c) => c.id),
          });
        } else {
          writeHuman(`dry-run: ${candidates.length} item(s) would move to archive/${args.label}:`);
          for (const c of candidates) writeHuman(`  ${c.id}\t${c.status}\t${c.title}`);
        }
        return;
      }
      const moved = await store.archive(args.label);
      if (format === 'json') {
        writeJson({ label: args.label, archived: moved });
      } else {
        writeHuman(`Archived ${moved.length} item(s) to .ditto/local/archive/${args.label}.`);
        for (const id of moved) writeHuman(`  ${id}`);
      }
    } catch (err) {
      writeError(`work archive failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

export const workCommand = defineCommand({
  meta: {
    name: 'work',
    description: 'Manage work items (start, status, handoff, done, abandon, archive)',
  },
  subCommands: {
    start: workStart,
    status: workStatus,
    handoff: workHandoff,
    done: workDone,
    abandon: workAbandon,
    archive: workArchive,
  },
});
