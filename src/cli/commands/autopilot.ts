import { defineCommand } from 'citty';
import { bootstrapAutopilot } from '~/core/autopilot-bootstrap';
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

export const autopilotCommand = defineCommand({
  meta: {
    name: 'autopilot',
    description: 'Manage the autopilot graph (bootstrap)',
  },
  subCommands: {
    bootstrap: autopilotBootstrap,
  },
});
