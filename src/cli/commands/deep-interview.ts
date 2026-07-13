import { defineCommand } from 'citty';
import { z } from 'zod';
import { readDeepInterviewConfigDefaults } from '~/core/ditto-config';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  acknowledgeIntentDissent,
  checkReadiness,
  deriveIntentFragments,
  finalizeInterview,
  finalizePayload,
  orderPendingBranchWork,
  projectInterviewDimensions,
  promotePremortem,
  promotePremortemPayload,
  recordIntentDissent,
  recordIntentSemanticCritique,
  recordPremortemRefutation,
  recordTurn,
  recordTurnPayload,
  selectIntentSemanticTargets,
  startInterview,
} from '~/core/interview-driver';
import { InterviewStore } from '~/core/interview-store';
import { finalizeFromDesignDoc } from '~/core/prism/finalize';
import type { OpponentSeamConfig } from '~/core/prism/opponent';
import {
  questionContextCandidate,
  selectSingleFire,
  validateQuestionContext,
} from '~/core/question-context';
import { WorkItemStore } from '~/core/work-item-store';
import {
  infoGain,
  interviewDissentVerdicts,
  interviewSemanticVerdicts,
  premortemRefutationVerdicts,
} from '~/schemas/interview-state';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';
import { autoClaimOnInProgressEdge, buildClaimWiring } from './work';

// Opponent model policy for the bare CLI (dialecticInput.model_policy defaults): Codex
// preferred, claude-opus synthesizer. opponent-router resolves the candidate order; the
// actual invocation is host-delegated (ADR-0001) and absent in the bare CLI, so the seam
// degrades to host_absent (ADR-0018). Mirrors prism.ts BARE_MODEL_POLICY.
const BARE_MODEL_POLICY: OpponentSeamConfig['policy'] = {
  producer: 'current-host',
  opponent_preferred: 'codex',
  opponent_fallback: [],
  synthesizer: 'claude-opus',
};

/**
 * The ORIGINAL intent text the intent-dissent opponent judges (wi_260709x5w). Sourced from
 * the work item Record (`source_request` preferred, `goal` fallback) — during the interview
 * intent.json does not yet exist (it is written at finalize), so the WI Record is the only
 * durable intent surface. Both fields are schema-required non-empty, so this always resolves.
 */
async function readWorkItemIntent(repoRoot: string, workItemId: string): Promise<string> {
  const item = await new WorkItemStore(repoRoot).get(workItemId);
  return item.source_request.trim().length > 0 ? item.source_request : item.goal;
}

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
      // 기제 C (wi_260706n4w): the CLI is the seam that turns user-intent dimension
      // seeding ON (driver default stays false for direct callers, ac-6) — same
      // pattern as coverage-next enabling `seedCategories`. Fail-open (ac-4): an
      // unanswered seed never blocks readiness and its category stays in the sweep.
      seedUserIntentDimensions: true,
    });
    // Surface the seeded user-intent lenses so the SKILL driver carries them into
    // the interview (at start, dimensions == exactly the seeds).
    const seededDimensions = state.dimensions.map((d) => d.id);
    if (format === 'json') {
      writeJson({
        work_item_id: state.work_item_id,
        status: state.status,
        threshold: state.readiness.threshold,
        question_cap: state.exit.question_cap,
        generators: state.generators,
        seeded_dimensions: seededDimensions,
        path: `.ditto/local/work-items/${state.work_item_id}/interview-state.json`,
      });
    } else {
      writeHuman(`Started interview for ${state.work_item_id}`);
      writeHuman(`  threshold:    ${state.readiness.threshold}`);
      writeHuman(`  question_cap: ${state.exit.question_cap}`);
      writeHuman(`  generators:   ${state.generators}`);
      writeHuman(`  seeded_dims:  ${seededDimensions.join(', ') || '(none)'}`);
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
      if (result.status === 'blocked_by_dissent') {
        writeError(
          'intent-dissent opponent flagged a critical dimension: the opponent found a ' +
            'stronger/more-accurate reading of the intent. Review each dissent, then acknowledge it ' +
            '(ditto deep-interview acknowledge-dissent --work-item <wi> --dimension <id>) and re-run finalize:',
        );
        for (const b of result.blocking) writeError(`  - [${b.dimension}] ${b.text}`);
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
      // wi_260709mqt: wire the intent-dissent opponent config. The bare CLI cannot spawn a
      // provider (ADR-0001) — its `isAvailable` is false and `delegate` returns null — so the
      // seam degrades to host_absent (ADR-0018) and critical dims deferral-close honestly.
      // The real host-delegated invocation is wired by the SKILL, mirroring prism's bare CLI.
      const opponentConfig: OpponentSeamConfig = {
        policy: BARE_MODEL_POLICY,
        currentHost: 'claude-code',
        isAvailable: () => ({ available: false, reason: 'runtime' }),
        delegate: async () => null,
        // wi_260709x5w: source the ORIGINAL intent from the WI Record (source_request/goal)
        // instead of the previous empty '' — so a wired host-delegated opponent never gets a
        // blank intent brief. The bare CLI still degrades to host_absent (isAvailable false),
        // but the intent is now correct for the SKILL's host-delegated path.
        intent: await readWorkItemIntent(repoRoot, args.workItem),
      };
      const result = await projectInterviewDimensions(repoRoot, args.workItem, opponentConfig);
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
        'Question candidate JSON: {text, why_matters, user_explanation, recommended_answer, background?, grounding?, self_answer_attempts?}',
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

// The deep-interview single-fire enforcement seam (impl-di-recommended-answer, ac-2).
// After the gate selects candidates, the SKILL runs THIS to collapse them to AT MOST ONE
// question — the deterministic `selectSingleFire` top-1 (highest info_gain_estimate;
// ties keep stable input order). This is the runtime call site that makes the single-fire
// cap "결정적 함수로 강제": the pure reducer is no longer an orphan, the CLI is its seam.
// Input is a minimal candidate list (each carries info_gain_estimate); all other fields
// pass through untouched so the chosen candidate is returned whole.
const singleFireCandidate = z
  .object({ info_gain_estimate: infoGain })
  .passthrough()
  .describe(
    'A gate-selected candidate carrying its info_gain_estimate (other fields pass through)',
  );

const selectSingleCmd = defineCommand({
  meta: {
    name: 'select-single',
    description:
      'Collapse the gate-selected candidates to the single deterministic top-1 (highest info_gain) before asking',
  },
  args: {
    json: {
      type: 'string',
      description: 'JSON array of gate-selected candidates, each carrying info_gain_estimate',
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
    const parsed = z.array(singleFireCandidate).safeParse(raw);
    if (!parsed.success) {
      writeError('--json failed schema validation:');
      for (const issue of parsed.error.issues) {
        writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const selected = selectSingleFire(parsed.data);
    const chosen = selected[0];
    if (format === 'json') {
      writeJson({ selected });
    } else if (chosen === undefined) {
      writeHuman('select-single: no candidate (empty selection)');
    } else {
      writeHuman(`select-single: 1 candidate (info_gain=${chosen.info_gain_estimate})`);
    }
  },
});

// wi_260709x5w: the intent-dissent opponent's LIVE briefs emit — mirror of prism
// `opponent-briefs`. Enumerates the critical dimensions the host must run the opponent
// against, each carrying its id + label + the ORIGINAL intent (WI Record). NO model call
// (ADR-0001); the host spawns intent-dissent-opponent agents and feeds verdicts back through
// `dissent-record`.
const dissentBriefsCmd = defineCommand({
  meta: {
    name: 'dissent-briefs',
    description:
      'Emit intent-dissent opponent briefs for the critical dimensions — no model call (ADR-0001).',
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
      const state = await new InterviewStore(repoRoot).get(args.workItem);
      const intent = await readWorkItemIntent(repoRoot, args.workItem);
      // Localization (cost): only CRITICAL dimensions face the opponent — same critical-only
      // scope the driver's projection uses (interview-driver §engageIntentDissent caller).
      const targets = state.dimensions
        .filter((d) => d.critical)
        .map((d) => ({ dimension_id: d.id, label: d.notes || d.id, intent }));
      if (format === 'json') {
        writeJson({ work_item_id: args.workItem, dissent_targets: targets });
      } else {
        writeHuman(`dissent-briefs: ${targets.length} critical dimension(s) for ${args.workItem}`);
        for (const t of targets) writeHuman(`  - [${t.dimension_id}] ${t.label}`);
      }
    } catch (err) {
      writeError(`dissent-briefs failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

// wi_260709hzg (#15): A1 semantic-critic targets — the deterministic HALF of the intent-layer
// achieve-vs-characterize critic (mirror of `dissent-briefs`). Decomposes the ORIGINAL intent
// (WI Record) into fragments, maps each RESOLVED dimension by whole-token match (fragmentKeywords,
// wi_260708jnp lesson), and emits the covered (fragment,dimension) pairs — capped at FANOUT_CAP.
// NO model call (ADR-0001); the host spawns a semantic critic per pair and feeds verdicts back
// through `semantic-record`. ADVISORY only — nothing here gates readiness/finalize.
const semanticTargetsCmd = defineCommand({
  meta: {
    name: 'semantic-targets',
    description:
      'Emit A1 achieve-vs-characterize critic targets for covered (fragment,dimension) pairs — no model call, capped (ADR-0001).',
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
      const state = await new InterviewStore(repoRoot).get(args.workItem);
      const intent = await readWorkItemIntent(repoRoot, args.workItem);
      const fragments = deriveIntentFragments(intent);
      const { targets, skipped_by_cap } = selectIntentSemanticTargets(fragments, state.dimensions);
      if (format === 'json') {
        writeJson({
          work_item_id: args.workItem,
          intent,
          semantic_targets: targets,
          skipped_by_cap,
        });
      } else {
        writeHuman(
          `semantic-targets: ${targets.length} covered pair(s) for ${args.workItem}${skipped_by_cap > 0 ? ` (+${skipped_by_cap} over cap)` : ''}`,
        );
        for (const t of targets)
          writeHuman(`  - [${t.dimension_id}] ${t.label} ⇐ ${t.fragment_id}`);
      }
    } catch (err) {
      writeError(`semantic-targets failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

// wi_260709hzg (#15): consume the host's A1 semantic-critic verdict JSON and persist the
// record-back onto the SEPARATE advisory `dimension.semantic_*` fields — mirror of
// `dissent-record`. Pass-in-JSON: JSON.parse→USAGE_ERROR, zod safeParse, then the driver's
// single-write fold (recordIntentSemanticCritique). Fail-closed: a verdict whose dimension_id ∉
// the interview dimensions is REJECTED (never an orphan critique); an empty (whitespace) text
// degrades to host_absent (ADR-0018). ADVISORY — this NEVER blocks finalize (non-blocking A1).
const semanticRecordCmd = defineCommand({
  meta: {
    name: 'semantic-record',
    description:
      'Record host-delegated A1 semantic critiques onto covered dimensions (advisory, non-blocking) — validated + fail-closed on foreign dimension ids (ADR-0018).',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    json: {
      type: 'string',
      description: 'Verdict payload JSON {verdicts:[{dimension_id,text}]}',
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
    const parsed = interviewSemanticVerdicts.safeParse(raw);
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
      const result = await recordIntentSemanticCritique(
        repoRoot,
        args.workItem,
        parsed.data.verdicts,
      );
      if (result.status === 'foreign') {
        writeError(
          `semantic-record: verdict dimension_id(s) absent from interview state — refusing orphan critique (ADR-0018): ${result.foreign.join(', ')}`,
        );
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (format === 'json') {
        writeJson({
          work_item_id: args.workItem,
          engaged: result.engaged,
          degraded: result.degraded,
        });
        return;
      }
      writeHuman(
        `semantic-record: ${result.engaged.length}건 기록(engaged), ${result.degraded.length}건 강등. (advisory — finalize 비차단)`,
      );
      if (result.engaged.length > 0) writeHuman(`  engaged: ${result.engaged.join(', ')}`);
      if (result.degraded.length > 0) {
        writeHuman(`  degraded(host_absent): ${result.degraded.join(', ')}`);
      }
    } catch (err) {
      writeError(`semantic-record failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

// wi_260709x5w: consume the host's intent-dissent verdict JSON and persist the record-back
// onto interview-state — mirror of prism `opponent-record`. Pass-in-JSON: JSON.parse in
// try/catch → USAGE_ERROR, then a zod safeParse (first defense), then the driver's
// single-write fold (recordIntentDissent). Fail-closed: a verdict whose dimension_id ∉ the
// interview dimensions is REJECTED (never an orphan dissent); an empty (whitespace) text
// degrades to host_absent, never a false engaged stamp (ADR-0018). `--briefed` surfaces
// briefed-but-unanswered dimensions so a dropped opponent judgment is visible.
const dissentRecordCmd = defineCommand({
  meta: {
    name: 'dissent-record',
    description:
      'Record host-delegated intent-dissent verdicts onto critical dimensions — validated + fail-closed on foreign dimension ids (ADR-0018).',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    json: {
      type: 'string',
      description: 'Verdict payload JSON {verdicts:[{dimension_id,text}]}',
      required: true,
    },
    briefed: {
      type: 'string',
      description: 'Optional comma-separated briefed dimension ids — surfaces unanswered concerns',
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
    const parsed = interviewDissentVerdicts.safeParse(raw);
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
      const result = await recordIntentDissent(repoRoot, args.workItem, parsed.data.verdicts);
      if (result.status === 'foreign') {
        writeError(
          `dissent-record: verdict dimension_id(s) absent from interview state — refusing orphan record (ADR-0018): ${result.foreign.join(', ')}`,
        );
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      const briefed = (args.briefed ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const answered = new Set(parsed.data.verdicts.map((v) => v.dimension_id));
      const unanswered = briefed.filter((id) => !answered.has(id));
      if (format === 'json') {
        writeJson({
          work_item_id: args.workItem,
          engaged: result.engaged,
          degraded: result.degraded,
          unanswered,
        });
        return;
      }
      writeHuman(
        `dissent-record: ${result.engaged.length}건 기록(engaged), ${result.degraded.length}건 강등.`,
      );
      if (result.engaged.length > 0) writeHuman(`  engaged: ${result.engaged.join(', ')}`);
      if (result.degraded.length > 0) {
        writeHuman(`  degraded(host_absent): ${result.degraded.join(', ')}`);
      }
      if (unanswered.length > 0) writeHuman(`  브리핑됐으나 미응답: ${unanswered.join(', ')}`);
    } catch (err) {
      writeError(`dissent-record failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

// wi_260709d3m (#17 AC-2): consume the host's pre-mortem refutation verdict JSON and persist
// the record-back onto interview-state.premortem — premortem twin of `dissent-record`.
// Pass-in-JSON: JSON.parse in try/catch → USAGE_ERROR, then a zod safeParse (first defense),
// then the driver's single-write fold (recordPremortemRefutation). Fail-closed: a verdict
// whose index is out of range OR points at a NON-high-blast item is REJECTED (never a
// refutation on a trivial item — the §17 localization guard); an empty (whitespace) text
// degrades to host_absent, never a false engaged stamp (ADR-0018).
const premortemRefuteRecordCmd = defineCommand({
  meta: {
    name: 'premortem-refute-record',
    description:
      'Record host-delegated pre-mortem refutations onto blast_radius>=high items — validated + fail-closed on foreign/out-of-range/non-high-blast index (ADR-0018).',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    json: {
      type: 'string',
      description: 'Verdict payload JSON {verdicts:[{index,text}]}',
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
    const parsed = premortemRefutationVerdicts.safeParse(raw);
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
      const result = await recordPremortemRefutation(repoRoot, args.workItem, parsed.data.verdicts);
      if (result.status === 'foreign') {
        writeError(
          `premortem-refute-record: verdict index(es) out of range or not blast_radius>=high — refusing record (§17 localization, ADR-0018): ${result.foreign.join(', ')}`,
        );
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (format === 'json') {
        writeJson({
          work_item_id: args.workItem,
          engaged: result.engaged,
          degraded: result.degraded,
        });
        return;
      }
      writeHuman(
        `premortem-refute-record: ${result.engaged.length}건 기록(engaged), ${result.degraded.length}건 강등.`,
      );
      if (result.engaged.length > 0) writeHuman(`  engaged(index): ${result.engaged.join(', ')}`);
      if (result.degraded.length > 0) {
        writeHuman(`  degraded(host_absent, index): ${result.degraded.join(', ')}`);
      }
    } catch (err) {
      writeError(
        `premortem-refute-record failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

// wi_260709mqt ac-3: the minimal unblock seam for the finalize dissent gate. After the
// intent-dissent opponent blocks finalize on a critical high-impact dissent, the user
// reviews it and acknowledges it here (re-confirmation), then re-runs finalize.
const acknowledgeDissentCmd = defineCommand({
  meta: {
    name: 'acknowledge-dissent',
    description:
      "Acknowledge a critical dimension's intent-dissent (user re-confirmation) so finalize passes",
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    dimension: { type: 'string', description: 'Dimension id carrying the dissent', required: true },
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
      const state = await acknowledgeIntentDissent(repoRoot, args.workItem, args.dimension);
      const dim = state.dimensions.find((d) => d.id === args.dimension);
      if (dim === undefined) {
        writeError(`dimension ${args.dimension} not found for ${args.workItem}`);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (format === 'json') {
        writeJson({
          work_item_id: args.workItem,
          dimension: args.dimension,
          acknowledged: dim.dissent?.acknowledged ?? false,
        });
      } else {
        writeHuman(
          `Acknowledged dissent on ${args.dimension} (${args.workItem}) — re-run finalize`,
        );
      }
    } catch (err) {
      writeError(`acknowledge-dissent failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

// The branch-walking continuity seam (wi_260713cx4, #27, ac-4/ac-5). The branch loop is
// SKILL-driven; to decide "what to ask next" DETERMINISTICALLY the driver runs THIS to get the
// pending work in continuity order (a branch walked contiguously, region transitions only at a
// seam) plus the open critical branch targets that must not be starved. This is the runtime call
// site for the pure `orderPendingBranchWork` (guard edges → orderByContinuity → criticalBranchesOpen),
// so the reducer is no longer an orphan — mirroring select-single's ROLE for single-fire.
//
// A PURE READ: it reads interview-state (like dissent-briefs/semantic-targets) and NEVER writes.
// It does not duplicate record-turn/check-readiness: those surface readiness + exit_reason (the
// value-exhaustion CLOSE signal, already folded into exit_reason=diminishing_returns), while this
// surfaces the ORDER + the anti-starvation view neither returns.
const branchOrderCmd = defineCommand({
  meta: {
    name: 'branch-order',
    description:
      'Return the pending interview work in continuity order (branch walked contiguously) + open critical branch targets — pure read, no state write',
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
      const state = await new InterviewStore(repoRoot).get(args.workItem);
      const { ordered, criticalBranchesOpen } = orderPendingBranchWork(state);
      if (format === 'json') {
        writeJson({
          work_item_id: args.workItem,
          ordered,
          critical_branches_open: criticalBranchesOpen,
        });
      } else {
        writeHuman(`branch-order: ${ordered.length} pending item(s) for ${args.workItem}`);
        for (const it of ordered) writeHuman(`  - [${it.id}] ${it.text}`);
        if (criticalBranchesOpen.length > 0) {
          writeHuman(`  open critical branch(es): ${criticalBranchesOpen.join(', ')}`);
        }
      }
    } catch (err) {
      writeError(`branch-order failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const finalizeFromDocCmd = defineCommand({
  meta: {
    name: 'finalize-from-doc',
    description:
      'Compile a confirmed prism/spec design document into intent.json THROUGH finalizeInterview, binding it by digest (prism → deep-interview compile)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    doc: {
      type: 'string',
      description: 'Design doc path (default .ditto/specs/<wi>-design.md)',
      required: false,
    },
    statement: {
      type: 'string',
      description: "The user's own words confirming the refined design (확정)",
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
    if (!args.statement || args.statement.trim().length === 0) {
      writeError(
        'finalize-from-doc requires --statement "<원문 확정>": the user confirmation is the 2차 gate half',
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const result = await finalizeFromDesignDoc(repoRoot, {
        workItemId: args.workItem,
        ...(args.doc ? { docPath: args.doc } : {}),
        userConfirmation: { confirmed: true, statement: args.statement },
      });
      if (result.status === 'compile_rejected') {
        writeError('design document did not compile — fix the compile-input sections and re-run:');
        for (const r of result.reasons) writeError(`  - ${r}`);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (result.status === 'not_ready') {
        writeError('interview is not ready; cannot finalize:');
        for (const r of result.gate.reasons) writeError(`  - ${r}`);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (result.status === 'not_confirmed') {
        writeError(
          'readiness gate passed (1차) but the user confirmation is missing (2차 게이트) — pass --statement',
        );
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (result.status === 'blocked_by_dissent') {
        writeError(
          'intent-dissent opponent flagged a critical dimension: acknowledge each dissent ' +
            '(ditto deep-interview acknowledge-dissent) and re-run:',
        );
        for (const b of result.blocking) writeError(`  - [${b.dimension}] ${b.text}`);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (format === 'json') {
        writeJson({
          work_item_id: result.intent.work_item_id,
          intent_path: `.ditto/local/work-items/${result.intent.work_item_id}/intent.json`,
          source_digest: result.intent.source_digest,
          autopilot_id: result.autopilot.autopilot_id,
          acceptance_criteria: result.intent.acceptance_criteria.map((ac) => ac.id),
        });
      } else {
        writeHuman(`Compiled design doc → intent for ${result.intent.work_item_id}`);
        writeHuman(`  source_digest: ${result.intent.source_digest?.sha256 ?? '(none)'}`);
        writeHuman(`  autopilot:     ${result.autopilot.autopilot_id}`);
        writeHuman(
          `  acceptance:    ${result.intent.acceptance_criteria.map((ac) => ac.id).join(', ')}`,
        );
      }
    } catch (err) {
      writeError(`finalize-from-doc failed: ${err instanceof Error ? err.message : String(err)}`);
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
    'check-question': checkQuestionCmd,
    'select-single': selectSingleCmd,
    'branch-order': branchOrderCmd,
    'check-readiness': checkReadinessCmd,
    'project-coverage': projectCoverageCmd,
    premortem: premortemCmd,
    'dissent-briefs': dissentBriefsCmd,
    'dissent-record': dissentRecordCmd,
    'premortem-refute-record': premortemRefuteRecordCmd,
    'semantic-targets': semanticTargetsCmd,
    'semantic-record': semanticRecordCmd,
    'acknowledge-dissent': acknowledgeDissentCmd,
    finalize: finalizeCmd,
    'finalize-from-doc': finalizeFromDocCmd,
  },
});
