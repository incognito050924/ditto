import { defineCommand } from 'citty';
import { bootstrapAutopilot } from '~/core/autopilot-bootstrap';
import { runCleanup } from '~/core/autopilot-cleanup';
import { assembleCompletionFromGraph } from '~/core/autopilot-complete';
import { nextNode, recordResult, recordResultPayload } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { CompletionStore } from '~/core/completion-store';
import { resolveRepoRootForCreate } from '~/core/fs';
import { IntentStore } from '~/core/intent-store';
import { WorkItemStore } from '~/core/work-item-store';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto autopilot bootstrap` — surface bootstrapAutopilot as a thin CLI so the
 * deep-interview `finalize` step (in-process call) and manual operators (CLI
 * call) reach the SAME core function. Idempotent on success: the second call
 * with the same intent re-writes an autopilot.json with a fresh autopilot_id
 * but identical structure.
 */
const autopilotBootstrap = defineCommand({
  meta: {
    name: 'bootstrap',
    description: 'Build the autopilot graph for a work item from its intent.json',
  },
  args: {
    workItem: {
      type: 'string',
      description: 'Work item id (wi_*) whose intent.json drives the graph',
      required: true,
    },
    riskNonLocal: {
      type: 'boolean',
      description: 'Set when the change touches code outside the obvious local site',
      default: false,
    },
    riskIrreversible: {
      type: 'boolean',
      description: 'Set when the change cannot be undone by a follow-up commit',
      default: false,
    },
    riskUnaudited: {
      type: 'boolean',
      description: 'Set when the change introduces dependencies / surfaces nobody has reviewed',
      default: false,
    },
    approvedSource: {
      type: 'string',
      description: 'Pre-approval source: approved_spec|issue|prd|user (omit for auto risk gate)',
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
    const approvedSource = args.approvedSource;
    if (
      approvedSource !== undefined &&
      !['approved_spec', 'issue', 'prd', 'user'].includes(approvedSource)
    ) {
      writeError(
        `invalid --approved-source "${approvedSource}"; expected one of: approved_spec, issue, prd, user`,
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const items = new WorkItemStore(repoRoot);
    if (!(await items.exists(args.workItem))) {
      writeError(`work item ${args.workItem} not found`);
      process.exit(RUNTIME_ERROR_EXIT);
      return;
    }
    const intentStore = new IntentStore(repoRoot);
    if (!(await intentStore.exists(args.workItem))) {
      writeError(
        `intent.json missing for ${args.workItem}. Run /ditto:deep-interview (ditto deep-interview finalize) first.`,
      );
      process.exit(RUNTIME_ERROR_EXIT);
      return;
    }
    const workItem = await items.get(args.workItem);
    const intent = await intentStore.get(args.workItem);
    const result = await bootstrapAutopilot(repoRoot, {
      workItem,
      intent,
      risk: {
        non_local: args.riskNonLocal,
        irreversible: args.riskIrreversible,
        unaudited: args.riskUnaudited,
      },
      ...(approvedSource
        ? { approvedSource: approvedSource as 'approved_spec' | 'issue' | 'prd' | 'user' }
        : {}),
    });
    if (result.status !== 'created') {
      writeError(`autopilot bootstrap failed (${result.status}):`);
      for (const reason of result.reasons) writeError(`  - ${reason}`);
      process.exit(RUNTIME_ERROR_EXIT);
      return;
    }
    if (format === 'json') {
      writeJson({
        work_item_id: args.workItem,
        autopilot_id: result.graph.autopilot_id,
        approval_gate: result.graph.approval_gate.status,
        node_ids: result.graph.nodes.map((n) => n.id),
        path: `.ditto/work-items/${args.workItem}/autopilot.json`,
      });
    } else {
      writeHuman(`Bootstrapped autopilot ${result.graph.autopilot_id}`);
      writeHuman(`  work_item:     ${args.workItem}`);
      writeHuman(`  approval_gate: ${result.graph.approval_gate.status}`);
      writeHuman(`  nodes:         ${result.graph.nodes.map((n) => n.id).join(' -> ')}`);
      writeHuman(`  path:          .ditto/work-items/${args.workItem}/autopilot.json`);
    }
  },
});

/**
 * `ditto autopilot next-node` / `record-result` — surface the deterministic loop
 * steps (G9) so the `autopilot` skill calls them instead of re-describing the
 * logic in prose. Same shape as the deep-interview step CLI: resolve repo root,
 * require an existing autopilot graph, call the core step function, render
 * human/json. The driver (main agent) loops by calling these repeatedly.
 */
async function requireGraph(workItem: string): Promise<string> {
  const repoRoot = await resolveRepoRootForCreate();
  if (!(await new AutopilotStore(repoRoot).exists(workItem))) {
    writeError(
      `autopilot.json missing for ${workItem}. Run ditto autopilot bootstrap (or deep-interview finalize) first.`,
    );
    process.exit(RUNTIME_ERROR_EXIT);
  }
  return repoRoot;
}

const autopilotNextNode = defineCommand({
  meta: {
    name: 'next-node',
    description:
      'Compute the next loop action (select ready node, consume approval gate, dispatch)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
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
    const repoRoot = await requireGraph(args.workItem);
    try {
      const res = await nextNode(repoRoot, args.workItem);
      if (format === 'json') {
        writeJson(res);
      } else if (res.action === 'spawn') {
        writeHuman(`Next: spawn ${res.owner} on ${res.node_id}`);
        writeHuman(`  task:       ${res.packet.task}`);
        writeHuman(`  done_when:  ${res.packet.context.done_when}`);
        writeHuman(`  file_scope: ${res.packet.context.file_scope.join(', ') || '(none)'}`);
      } else if (res.action === 'spawn_wave') {
        writeHuman(`Next: spawn wave (${res.spawns.length} parallel nodes)`);
        for (const s of res.spawns) {
          writeHuman(`  - ${s.owner} on ${s.node_id}: ${s.packet.task}`);
        }
      } else {
        writeHuman(`Next: ${res.action} — ${res.reason}`);
        if (res.action === 'rollback') {
          writeHuman(`  rolled_back: ${res.rolled_back_node_ids.join(', ') || '(none)'}`);
        } else if (res.action === 'blocked') {
          writeHuman(`  blocked:     ${res.blocked_node_ids.join(', ') || '(none)'}`);
        } else if (res.action === 'done') {
          writeHuman(
            `  → run completion (${res.all_passed ? 'expect pass' : 'expect partial/fail'})`,
          );
        } else if (res.action === 'cleanup') {
          writeHuman(`  node:        ${res.node_id}`);
          writeHuman(`  → run: ditto autopilot cleanup --workItem <wi> --node ${res.node_id}`);
        }
      }
    } catch (err) {
      writeError(`next-node failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const autopilotRecordResult = defineCommand({
  meta: {
    name: 'record-result',
    description: "Record an owner subagent's result: G7 guard, classify, decide, persist",
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    json: {
      type: 'string',
      description: 'JSON payload matching recordResultPayload schema',
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
    let raw: unknown;
    try {
      raw = JSON.parse(args.json);
    } catch (err) {
      writeError(`--json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const parsed = recordResultPayload.safeParse(raw);
    if (!parsed.success) {
      writeError('--json failed schema validation:');
      for (const issue of parsed.error.issues) {
        writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await requireGraph(args.workItem);
    try {
      const res = await recordResult(repoRoot, { workItemId: args.workItem, payload: parsed.data });
      if (format === 'json') {
        writeJson(res);
      } else {
        writeHuman(`Recorded ${res.node_id}: ${res.outcome} → status=${res.status}`);
        if (!res.guard_contentful) {
          writeHuman('  (G7: non-contentful result — claimed outcome overridden to fixable)');
        }
        if (res.decision) {
          writeHuman(`  decision: ${res.decision}${res.cap_exceeded ? ' (cap exceeded)' : ''}`);
        }
      }
    } catch (err) {
      writeError(`record-result failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto autopilot complete` — assemble a completion contract from the finished
 * graph (done→completion bridge). Maps each acceptance criterion to the evidence
 * the nodes collected and derives its verdict, evidence-gated (a pass needs a
 * passed addressing node WITH evidence; otherwise unverified). Not auto-pass —
 * `final_verdict=pass` still demands every AC closed with real evidence (§6.8).
 */
const autopilotComplete = defineCommand({
  meta: {
    name: 'complete',
    description:
      'Assemble a completion contract from the finished autopilot graph (evidence-gated)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    summary: {
      type: 'string',
      description: 'Completion narrative; a terse default is derived when omitted',
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
    const repoRoot = await requireGraph(args.workItem);
    try {
      const graph = await new AutopilotStore(repoRoot).get(args.workItem);
      const workItem = await new WorkItemStore(repoRoot).get(args.workItem);
      const completion = assembleCompletionFromGraph(graph, workItem, {
        ...(args.summary ? { summary: args.summary } : {}),
      });
      await new CompletionStore(repoRoot).write(completion);
      if (format === 'json') {
        writeJson({
          work_item_id: args.workItem,
          final_verdict: completion.final_verdict,
          acceptance: completion.acceptance.map((a) => ({
            criterion_id: a.criterion_id,
            verdict: a.verdict,
            evidence_count: a.evidence.length,
          })),
          path: `.ditto/work-items/${args.workItem}/completion.json`,
        });
      } else {
        writeHuman(
          `Assembled completion for ${args.workItem}: final_verdict=${completion.final_verdict}`,
        );
        for (const a of completion.acceptance) {
          writeHuman(`  ${a.criterion_id}: ${a.verdict} (${a.evidence.length} evidence)`);
        }
        if (completion.final_verdict !== 'pass') {
          writeHuman(
            '  (non-pass: criteria without evidence stay unverified — close them, then re-run)',
          );
        }
      }
    } catch (err) {
      writeError(`complete failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto autopilot cleanup` — run the deterministic cleanup step for a
 * `driver`-owned (cleanup) node: tear down the per-run git worktrees (§2.2).
 * Worktree removal is irreversible git work, so it is gated by an EXPLICIT
 * approval — pass `--approve` to authorize. Without it (and with worktrees to
 * remove) the node is blocked and the teardown plan is surfaced for a decision.
 */
const autopilotCleanup = defineCommand({
  meta: {
    name: 'cleanup',
    description:
      'Run the deterministic cleanup step for a driver-owned node (gated worktree teardown)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    node: { type: 'string', description: 'Cleanup node id', required: true },
    approve: {
      type: 'boolean',
      description: 'Explicit approval for the irreversible git (worktree removal) step',
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
    const repoRoot = await requireGraph(args.workItem);
    try {
      const res = await runCleanup(repoRoot, {
        workItemId: args.workItem,
        nodeId: args.node,
        approve: args.approve,
      });
      if (format === 'json') {
        writeJson(res);
      } else if (res.status === 'blocked') {
        writeHuman(`Cleanup ${res.node_id}: blocked — ${res.reason}`);
        writeHuman(`  plan (${res.plan.length}): ${res.plan.join(', ') || '(none)'}`);
        writeHuman('  → re-run with --approve to authorize the irreversible git step');
      } else {
        writeHuman(
          `Cleanup ${res.node_id}: passed — removed ${res.removed.length}/${res.plan.length} worktree(s)`,
        );
        if (res.skipped.length > 0) {
          for (const s of res.skipped) writeHuman(`  skipped: ${s.path} (${s.reason})`);
        }
      }
    } catch (err) {
      writeError(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const autopilotCommand = defineCommand({
  meta: {
    name: 'autopilot',
    description:
      'Manage the autopilot graph (bootstrap) and drive the loop (next-node/record-result/complete/cleanup)',
  },
  subCommands: {
    bootstrap: autopilotBootstrap,
    'next-node': autopilotNextNode,
    'record-result': autopilotRecordResult,
    complete: autopilotComplete,
    cleanup: autopilotCleanup,
  },
});
