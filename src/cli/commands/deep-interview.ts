import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  checkReadiness,
  finalizeInterview,
  finalizePayload,
  recordTurn,
  recordTurnPayload,
  startInterview,
} from '~/core/interview-driver';
import { WorkItemStore } from '~/core/work-item-store';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

function parseJsonArg(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `--json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const startCmd = defineCommand({
  meta: {
    name: 'start',
    description: 'Initialize interview-state.json for a work item',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    threshold: {
      type: 'string',
      description: 'Readiness threshold 0..1 (default 0.7)',
      required: false,
    },
    questionCap: {
      type: 'string',
      description: 'Maximum questions before exit=cap_reached (default 8)',
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
    const threshold = args.threshold === undefined ? undefined : Number(args.threshold);
    if (
      threshold !== undefined &&
      (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    ) {
      writeError(`--threshold must be a number in [0, 1]; got "${args.threshold}"`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const questionCap = args.questionCap === undefined ? undefined : Number(args.questionCap);
    if (questionCap !== undefined && (!Number.isInteger(questionCap) || questionCap <= 0)) {
      writeError(`--question-cap must be a positive integer; got "${args.questionCap}"`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    if (!(await new WorkItemStore(repoRoot).exists(args.workItem))) {
      writeError(`work item ${args.workItem} not found`);
      process.exit(RUNTIME_ERROR_EXIT);
      return;
    }
    const state = await startInterview(repoRoot, {
      workItemId: args.workItem,
      ...(threshold !== undefined ? { threshold } : {}),
      ...(questionCap !== undefined ? { questionCap } : {}),
    });
    if (format === 'json') {
      writeJson({
        work_item_id: state.work_item_id,
        status: state.status,
        threshold: state.readiness.threshold,
        question_cap: state.exit.question_cap,
        path: `.ditto/local/work-items/${state.work_item_id}/interview-state.json`,
      });
    } else {
      writeHuman(`Started interview for ${state.work_item_id}`);
      writeHuman(`  threshold:    ${state.readiness.threshold}`);
      writeHuman(`  question_cap: ${state.exit.question_cap}`);
      writeHuman(
        `  path:         .ditto/local/work-items/${state.work_item_id}/interview-state.json`,
      );
    }
  },
});

const recordTurnCmd = defineCommand({
  meta: {
    name: 'record-turn',
    description: 'Append one interview turn (dimension upsert + question + optional answer)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    json: {
      type: 'string',
      description: 'JSON payload matching recordTurnPayload schema',
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
      raw = parseJsonArg(args.json);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const parsed = recordTurnPayload.safeParse(raw);
    if (!parsed.success) {
      writeError('--json failed schema validation:');
      for (const issue of parsed.error.issues) {
        writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const state = await recordTurn(repoRoot, {
        workItemId: args.workItem,
        payload: parsed.data,
      });
      if (format === 'json') {
        writeJson({
          work_item_id: state.work_item_id,
          questions_asked: state.exit.questions_asked,
          readiness_score: state.readiness.score,
          readiness_gate: state.readiness.gate,
          critical_unresolved: state.readiness.critical_unresolved,
          exit_reason: state.exit.reason,
        });
      } else {
        writeHuman(`Recorded turn for ${state.work_item_id}`);
        writeHuman(
          `  questions_asked:     ${state.exit.questions_asked}/${state.exit.question_cap}`,
        );
        writeHuman(
          `  readiness:           ${state.readiness.score.toFixed(2)} (${state.readiness.gate})`,
        );
        writeHuman(
          `  critical_unresolved: ${state.readiness.critical_unresolved.join(', ') || '(none)'}`,
        );
      }
    } catch (err) {
      writeError(`record-turn failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const checkReadinessCmd = defineCommand({
  meta: {
    name: 'check-readiness',
    description: 'Evaluate interviewReadinessGate without mutating state',
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
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const result = await checkReadiness(repoRoot, args.workItem);
      if (format === 'json') {
        writeJson({
          work_item_id: result.state.work_item_id,
          pass: result.gate.pass,
          reasons: result.gate.reasons,
          critical_unresolved: result.critical_unresolved,
          cap_reached: result.cap_reached,
          questions_asked: result.state.exit.questions_asked,
          readiness_score: result.state.readiness.score,
        });
      } else {
        writeHuman(
          `Readiness for ${result.state.work_item_id}: ${result.gate.pass ? 'READY' : 'BLOCKED'}`,
        );
        for (const r of result.gate.reasons) writeHuman(`  - ${r}`);
        if (result.cap_reached) writeHuman('  (question cap reached)');
      }
    } catch (err) {
      writeError(`check-readiness failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const finalizeCmd = defineCommand({
  meta: {
    name: 'finalize',
    description:
      'Lock the interview: write intent.json, mirror AC into work item, bootstrap autopilot',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    json: {
      type: 'string',
      description: 'JSON payload matching finalizePayload schema',
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
      raw = parseJsonArg(args.json);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const parsed = finalizePayload.safeParse(raw);
    if (!parsed.success) {
      writeError('--json failed schema validation:');
      for (const issue of parsed.error.issues) {
        writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const result = await finalizeInterview(repoRoot, {
        workItemId: args.workItem,
        payload: parsed.data,
      });
      if (result.status === 'not_ready') {
        writeError('interview is not ready; cannot finalize:');
        for (const r of result.gate.reasons) writeError(`  - ${r}`);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (result.status === 'not_confirmed') {
        writeError(
          'readiness gate passed (1차) but the user has not confirmed the intent (2차 게이트): ' +
            'capture the user confirmation (user_confirmation.confirmed=true with their statement) and re-run finalize',
        );
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (format === 'json') {
        writeJson({
          work_item_id: result.intent.work_item_id,
          intent_path: `.ditto/local/work-items/${result.intent.work_item_id}/intent.json`,
          autopilot_id: result.autopilot.autopilot_id,
          autopilot_path: `.ditto/local/work-items/${result.intent.work_item_id}/autopilot.json`,
          approval_gate: result.autopilot.approval_gate.status,
          node_ids: result.autopilot.nodes.map((n) => n.id),
          acceptance_criteria: result.intent.acceptance_criteria.map((ac) => ac.id),
        });
      } else {
        writeHuman(`Finalized interview for ${result.intent.work_item_id}`);
        writeHuman(
          `  intent:        .ditto/local/work-items/${result.intent.work_item_id}/intent.json`,
        );
        writeHuman(`  autopilot:     ${result.autopilot.autopilot_id}`);
        writeHuman(`  approval_gate: ${result.autopilot.approval_gate.status}`);
        writeHuman(
          `  acceptance:    ${result.intent.acceptance_criteria.map((ac) => ac.id).join(', ')}`,
        );
        writeHuman(`  nodes:         ${result.autopilot.nodes.map((n) => n.id).join(' -> ')}`);
      }
    } catch (err) {
      writeError(`finalize failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const deepInterviewCommand = defineCommand({
  meta: {
    name: 'deep-interview',
    description:
      'Drive the deep-interview state machine (start/record-turn/check-readiness/finalize)',
  },
  subCommands: {
    start: startCmd,
    'record-turn': recordTurnCmd,
    'check-readiness': checkReadinessCmd,
    finalize: finalizeCmd,
  },
});
