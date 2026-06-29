import { defineCommand } from 'citty';
import { readDeepInterviewConfigDefaults } from '~/core/ditto-config';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  checkReadiness,
  finalizeInterview,
  finalizePayload,
  projectInterviewDimensions,
  promotePremortem,
  promotePremortemPayload,
  recordTurn,
  recordTurnPayload,
  startInterview,
} from '~/core/interview-driver';
import { questionContextCandidate, validateQuestionContext } from '~/core/question-context';
import { WorkItemStore } from '~/core/work-item-store';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';
import { autoClaimOnInProgressEdge, buildClaimWiring } from './work';

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
    generators: {
      type: 'string',
      description: 'Parallel question-generator fan-out count for the SKILL loop (default 1)',
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
    const cliThreshold = args.threshold === undefined ? undefined : Number(args.threshold);
    if (
      cliThreshold !== undefined &&
      (!Number.isFinite(cliThreshold) || cliThreshold < 0 || cliThreshold > 1)
    ) {
      writeError(`--threshold must be a number in [0, 1]; got "${args.threshold}"`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const cliQuestionCap = args.questionCap === undefined ? undefined : Number(args.questionCap);
    if (
      cliQuestionCap !== undefined &&
      (!Number.isInteger(cliQuestionCap) || cliQuestionCap <= 0)
    ) {
      writeError(`--question-cap must be a positive integer; got "${args.questionCap}"`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const cliGenerators = args.generators === undefined ? undefined : Number(args.generators);
    if (cliGenerators !== undefined && (!Number.isInteger(cliGenerators) || cliGenerators <= 0)) {
      writeError(`--generators must be a positive integer; got "${args.generators}"`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    // Per-user defaults (.ditto/local/config.json `deep_interview`) fill absent CLI
    // flags; an explicit flag still wins. Broken config is fail-open (start proceeds
    // with code defaults) but warns, so a silently-ignored config doesn't look like
    // it "did nothing".
    const configDefaults = await readDeepInterviewConfigDefaults(repoRoot, () =>
      writeError(
        'warning: .ditto/local/config.json could not be parsed — ignoring it and using defaults',
      ),
    );
    const threshold = cliThreshold ?? configDefaults.threshold;
    const questionCap = cliQuestionCap ?? configDefaults.question_cap;
    const generators = cliGenerators ?? configDefaults.generators;
    if (!(await new WorkItemStore(repoRoot).exists(args.workItem))) {
      writeError(`work item ${args.workItem} not found`);
      process.exit(RUNTIME_ERROR_EXIT);
      return;
    }
    const state = await startInterview(repoRoot, {
      workItemId: args.workItem,
      ...(threshold !== undefined ? { threshold } : {}),
      ...(questionCap !== undefined ? { questionCap } : {}),
      ...(generators !== undefined ? { generators } : {}),
    });
    if (format === 'json') {
      writeJson({
        work_item_id: state.work_item_id,
        status: state.status,
        threshold: state.readiness.threshold,
        question_cap: state.exit.question_cap,
        generators: state.generators,
        path: `.ditto/local/work-items/${state.work_item_id}/interview-state.json`,
      });
    } else {
      writeHuman(`Started interview for ${state.work_item_id}`);
      writeHuman(`  threshold:    ${state.readiness.threshold}`);
      writeHuman(`  question_cap: ${state.exit.question_cap}`);
      writeHuman(`  generators:   ${state.generators}`);
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
      // wi_2606287v9 (#5) ac-2: capture the WI status BEFORE finalize. finalize funnels
      // through core bootstrapAutopilot, which promotes draft→in_progress at the chokepoint.
      const items = new WorkItemStore(repoRoot);
      const before = await items.get(args.workItem);
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
      // wi_2606287v9 (#5) ac-2 / n8-review F1: fire the claim ONCE on the in_progress
      // edge that core bootstrapAutopilot just produced — the SAME n6 helper the CLI
      // `ditto autopilot bootstrap` path fires (autopilot.ts), so both entry points are
      // symmetric. Only when the WI is actually linked to an issue (else the status
      // promotion stands alone, no gh subprocess). Idempotent: a re-finalize finds the WI
      // already in_progress, so the prev=in_progress edge is a zero-gh no-op. gh failures
      // are notices, never throws (ADR-0018) — they cannot undo the finalize.
      const claimNotices: string[] = [];
      const after = await items.get(args.workItem);
      if (after.github_issue && before.status !== 'in_progress' && after.status === 'in_progress') {
        const wiring = await buildClaimWiring(repoRoot);
        const claimRes = await autoClaimOnInProgressEdge(
          items,
          args.workItem,
          before.status,
          after,
          wiring,
        );
        claimNotices.push(...claimRes.warnings, ...claimRes.notices);
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
          // wi_2606289h9 C5: surface GitHub claim/board-move notices to the JSON consumer
          // too — the canonical path used to drop them on the human-only branch (the
          // silent-skip this WI kills).
          claim_notices: claimNotices,
        });
      } else {
        writeHuman(`Finalized interview for ${result.intent.work_item_id}`);
        for (const n of claimNotices) writeHuman(`  GitHub claim: ${n}`);
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

const projectCoverageCmd = defineCommand({
  meta: {
    name: 'project-coverage',
    description:
      'Project interview dimensions onto the SHARED coverage tree (intent stage); writes coverage.json + intent-dialog.md',
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
      const result = await projectInterviewDimensions(repoRoot, args.workItem);
      const closed = result.map.nodes.filter((n) => n.state !== 'open').length;
      if (format === 'json') {
        writeJson({
          work_item_id: args.workItem,
          coverage_path: `.ditto/local/runs/${args.workItem}/coverage.json`,
          ...(result.intentDialogPath ? { intent_dialog_path: result.intentDialogPath } : {}),
          node_count: result.map.nodes.length,
          closed_count: closed,
          node_ids: result.map.nodes.map((n) => n.id),
        });
      } else {
        writeHuman(`Projected interview dimensions for ${args.workItem}`);
        writeHuman(`  coverage:  .ditto/local/runs/${args.workItem}/coverage.json`);
        writeHuman(`  nodes:     ${result.map.nodes.length} (${closed} closed)`);
      }
    } catch (err) {
      writeError(`project-coverage failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const premortemCmd = defineCommand({
  meta: {
    name: 'premortem',
    description:
      'Record pre-mortem items + enforce §5 승격 rule (irreversible/high-blast MUST be promoted)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    json: {
      type: 'string',
      description: 'JSON payload matching promotePremortemPayload schema',
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
    const parsed = promotePremortemPayload.safeParse(raw);
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
      const result = await promotePremortem(repoRoot, args.workItem, parsed.data);
      // §5 fail-closed: an irreversible/high-blast item left promoted_to:'none' is
      // a contract violation — the items were recorded but the gate is not met.
      if (result.unpromoted.length > 0) {
        writeError(
          `${result.unpromoted.length} critical pre-mortem item(s) require promotion (§5) but are promoted_to:'none' — promote each to ac | out_of_scope | user_owned_decision and re-run:`,
        );
        for (const item of result.unpromoted) {
          writeError(`  - [${item.reversibility}/blast:${item.blast_radius}] ${item.scenario}`);
        }
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (format === 'json') {
        writeJson({
          work_item_id: args.workItem,
          premortem_count: result.state.premortem.length,
          promoted: result.state.premortem.map((p) => ({
            scenario: p.scenario,
            promoted_to: p.promoted_to,
            ref: p.ref,
          })),
        });
      } else {
        writeHuman(`Recorded ${parsed.data.items.length} pre-mortem item(s) for ${args.workItem}`);
        writeHuman(`  total premortem items: ${result.state.premortem.length}`);
      }
    } catch (err) {
      writeError(`premortem failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

// The presentation-contract gate (wi_260622ph8). The SKILL runs this on each
// gate-selected candidate BEFORE presenting it to the user — a candidate missing
// the comprehensible, decision-sufficient context (user_explanation) is rejected
// (exit non-zero) so the driver regenerates instead of asking a context-less
// question. Structural presence check; quality is the LLM gate's job.
const checkQuestionCmd = defineCommand({
  meta: {
    name: 'check-question',
    description:
      'Gate a question candidate against the presentation contract (why·value·user-language) before asking',
  },
  args: {
    json: {
      type: 'string',
      description:
        'Question candidate JSON: {text, why_matters, user_explanation, background?, grounding?, self_answer_attempts?}',
      required: true,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: ({ args }) => {
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
    const parsed = questionContextCandidate.safeParse(raw);
    if (!parsed.success) {
      writeError('--json failed schema validation:');
      for (const issue of parsed.error.issues) {
        writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const verdict = validateQuestionContext(parsed.data);
    if (format === 'json') {
      writeJson(verdict);
    } else if (verdict.ok) {
      writeHuman('check-question: ok (presentation contract satisfied)');
    } else {
      writeError('check-question: REJECTED — under-contextualized, do not ask as-is:');
      for (const v of verdict.violations) {
        writeError(`  - ${v.field}: ${v.reason}`);
      }
    }
    // Non-zero exit on rejection so the SKILL/driver can branch (regenerate) on it.
    if (!verdict.ok) process.exit(RUNTIME_ERROR_EXIT);
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
    'check-question': checkQuestionCmd,
    'check-readiness': checkReadinessCmd,
    'project-coverage': projectCoverageCmd,
    premortem: premortemCmd,
    finalize: finalizeCmd,
  },
});
