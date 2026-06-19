import { defineCommand } from 'citty';
import { readQuestionConfigDefaults } from '~/core/ditto-config';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  finalizeTechSpec,
  finalizeTechSpecPayload,
  nextRound,
  recordRound,
  recordRoundPayload,
  recordSection,
  recordSectionPayload,
  startTechSpec,
} from '~/core/tech-spec';
import {
  type GateMode,
  type GeneratorEffort,
  type Granularity,
  type PerformancePreset,
  type RawQuestionConfig,
  resolveQuestionConfig,
} from '~/core/tech-spec-options';
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

const PERFORMANCE_VALUES = ['glance', 'quick', 'standard', 'deep', 'exhaustive'] as const;
const EFFORT_VALUES = ['low', 'medium', 'high', 'inherit'] as const;
const GATE_MODE_VALUES = ['confirm', 'draft'] as const;
const GRANULARITY_VALUES = ['low', 'medium', 'high'] as const;

/** Coerce a string arg to an integer in [min,max], or throw a usage error. */
function intArg(raw: string, label: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`--${label} must be an integer in [${min}, ${max}]; got "${raw}"`);
  }
  return n;
}

/** Coerce a string arg to one of `values`, or throw a usage error. */
function enumArg<T extends string>(raw: string, label: string, values: readonly T[]): T {
  if (!(values as readonly string[]).includes(raw)) {
    throw new Error(`--${label} must be ${values.join('|')}; got "${raw}"`);
  }
  return raw as T;
}

type StartArgs = Record<string, unknown>;

/**
 * Validate the §6-6 question-elicitation args and resolve the effective config
 * (wi_260619yfw). Only explicitly-passed options enter the raw config; the
 * resolver applies precedence and defaults (= current behavior). Bad values
 * (out-of-range intensity, generators∉1..6, undefined enum, threshold∉[0,1])
 * are rejected here — this is ac-1's evidence.
 *
 * `configRaw` carries the per-user `.ditto/local/config.json` defaults
 * (wi_260619jmu): they apply when a CLI flag is absent, but explicit CLI wins.
 */
function parseQuestionConfigArgs(
  args: StartArgs,
  configRaw: RawQuestionConfig,
): ReturnType<typeof resolveQuestionConfig> {
  const raw: RawQuestionConfig = {};
  const intensity = args.intensity as string | undefined;
  if (intensity !== undefined) raw.intensity = intArg(intensity, 'intensity', 0, 100);
  const generators = args.generators as string | undefined;
  if (generators !== undefined) raw.generators = intArg(generators, 'generators', 1, 6);
  const maxQuestions = args['max-questions'] as string | undefined;
  if (maxQuestions !== undefined)
    raw.max_questions = intArg(maxQuestions, 'max-questions', 0, 1_000_000);
  const maxRounds = args['max-rounds'] as string | undefined;
  if (maxRounds !== undefined) raw.max_rounds = intArg(maxRounds, 'max-rounds', 0, 1_000_000);
  const performance = args.performance as string | undefined;
  if (performance !== undefined) {
    raw.performance = enumArg<PerformancePreset>(performance, 'performance', PERFORMANCE_VALUES);
  }
  const effort = args['generator-effort'] as string | undefined;
  if (effort !== undefined) {
    raw.generator_effort = enumArg<GeneratorEffort>(effort, 'generator-effort', EFFORT_VALUES);
  }
  const gateMode = args['gate-mode'] as string | undefined;
  if (gateMode !== undefined) {
    raw.gate_mode = enumArg<GateMode>(gateMode, 'gate-mode', GATE_MODE_VALUES);
  }
  const granularity = args.granularity as string | undefined;
  if (granularity !== undefined) {
    raw.granularity = enumArg<Granularity>(granularity, 'granularity', GRANULARITY_VALUES);
  }
  const threshold = args.threshold as string | undefined;
  if (threshold !== undefined) {
    const t = Number(threshold);
    if (!Number.isFinite(t) || t < 0 || t > 1) {
      throw new Error(`--threshold must be a number in [0, 1]; got "${threshold}"`);
    }
    raw.threshold = t;
  }
  return resolveQuestionConfig(raw, configRaw);
}

const startCmd = defineCommand({
  meta: {
    name: 'start',
    description:
      'Initialize tech-spec-state.json for a work item (doc path + mode + question tuning)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    doc: {
      type: 'string',
      description: 'Spec document path relative to repo root (e.g. .ditto/specs/<slug>.md)',
      required: true,
    },
    mode: {
      type: 'string',
      description: 'Writing/review rhythm: stepwise (default) | oneshot',
      default: 'stepwise',
    },
    // §6-6 question-elicitation tuning (wi_260619yfw). Defaults preserve current behavior.
    intensity: {
      type: 'string',
      alias: 'i',
      description:
        'Unified dial 0..100 over {gate threshold, granularity, count/rounds} (default 60)',
    },
    generators: {
      type: 'string',
      alias: 'g',
      description: 'Generator fan-out count 1..6 (default 2)',
    },
    performance: {
      type: 'string',
      alias: 'p',
      description: `Preset ${PERFORMANCE_VALUES.join('|')} (default standard)`,
    },
    'generator-effort': {
      type: 'string',
      alias: 'e',
      description: `Generator effort ${EFFORT_VALUES.join('|')} (default inherit)`,
    },
    'gate-mode': {
      type: 'string',
      alias: 'm',
      description: `Gate mode ${GATE_MODE_VALUES.join('|')} (default confirm)`,
    },
    'max-questions': {
      type: 'string',
      alias: 'q',
      description: 'Question ceiling (default 0 = unlimited, opt-in cap)',
    },
    'max-rounds': {
      type: 'string',
      alias: 'r',
      description: 'Round ceiling (default 0 = unlimited, opt-in cap)',
    },
    threshold: {
      type: 'string',
      alias: 't',
      description: 'Selection threshold 0..1 — advanced override of the intensity-derived value',
    },
    granularity: {
      type: 'string',
      alias: 'd',
      description: `Granularity ${GRANULARITY_VALUES.join('|')} — advanced override of the intensity-derived value`,
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
    if (args.mode !== 'stepwise' && args.mode !== 'oneshot') {
      writeError(`--mode must be stepwise|oneshot; got "${args.mode}"`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    let questionConfig: ReturnType<typeof resolveQuestionConfig>;
    try {
      // Per-user defaults (.ditto/local/config.json) fill absent CLI flags; CLI wins.
      const configRaw = await readQuestionConfigDefaults(repoRoot);
      questionConfig = parseQuestionConfigArgs(args, configRaw);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (!(await new WorkItemStore(repoRoot).exists(args.workItem))) {
      writeError(`work item ${args.workItem} not found`);
      process.exit(RUNTIME_ERROR_EXIT);
      return;
    }
    const state = await startTechSpec(repoRoot, {
      workItemId: args.workItem,
      docPath: args.doc,
      mode: args.mode,
      questionConfig,
    });
    if (format === 'json') {
      writeJson({
        work_item_id: state.work_item_id,
        doc_path: state.doc_path,
        mode: state.mode,
        path: `.ditto/local/work-items/${state.work_item_id}/tech-spec-state.json`,
      });
    } else {
      writeHuman(`Started tech-spec for ${state.work_item_id}`);
      writeHuman(`  doc:  ${state.doc_path}`);
      writeHuman(`  mode: ${state.mode}`);
    }
  },
});

const recordSectionCmd = defineCommand({
  meta: {
    name: 'record-section',
    description:
      'Upsert one section record (review state + grounding evidence; factual sections reject without evidence — ac-9)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    json: {
      type: 'string',
      description: 'JSON payload matching recordSectionPayload schema',
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
    const parsed = recordSectionPayload.safeParse(raw);
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
      const state = await recordSection(repoRoot, {
        workItemId: args.workItem,
        payload: parsed.data,
      });
      if (format === 'json') {
        writeJson({
          work_item_id: state.work_item_id,
          sections: state.sections.map((s) => ({ id: s.id, review: s.review })),
        });
      } else {
        writeHuman(`Recorded section ${parsed.data.section.id} for ${state.work_item_id}`);
        writeHuman(`  coverage: ${state.sections.map((s) => `${s.id}=${s.review}`).join(', ')}`);
      }
    } catch (err) {
      writeError(`record-section failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const recordRoundCmd = defineCommand({
  meta: {
    name: 'record-round',
    description:
      'Append one question-generation round’s gate scores to the durable score trail (selected + all_scored + dry; consumed by doctor intent-quality)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    json: {
      type: 'string',
      description:
        'JSON payload matching recordRoundPayload schema (round, dry, selected, all_scored, ...)',
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
    const parsed = recordRoundPayload.safeParse(raw);
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
      const record = await recordRound(repoRoot, {
        workItemId: args.workItem,
        payload: parsed.data,
      });
      if (format === 'json') {
        writeJson({
          work_item_id: record.work_item_id,
          round: record.round,
          dry: record.dry,
          selected: record.selected.length,
          all_scored: record.all_scored.length,
        });
      } else {
        writeHuman(
          `Recorded round ${record.round} for ${record.work_item_id} (selected ${record.selected.length}, scored ${record.all_scored.length}${record.dry ? ', dry' : ''})`,
        );
      }
    } catch (err) {
      writeError(`record-round failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const finalizeCmd = defineCommand({
  meta: {
    name: 'finalize',
    description:
      'Compile the spec document into intent.json (+source_digest), record review coverage, bootstrap autopilot',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    json: {
      type: 'string',
      description:
        'JSON payload matching finalizeTechSpecPayload schema (risk + user_confirmation)',
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
    const parsed = finalizeTechSpecPayload.safeParse(raw);
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
      const result = await finalizeTechSpec(repoRoot, {
        workItemId: args.workItem,
        payload: parsed.data,
      });
      if (result.status !== 'finalized') {
        switch (result.status) {
          case 'not_started':
            writeError(
              'tech-spec was never started for this work item — run `ditto tech-spec start` first',
            );
            break;
          case 'doc_missing':
            writeError(`spec document not found: ${result.doc_path}`);
            break;
          case 'compile_rejected':
            writeError('spec document failed to compile (fail-closed):');
            for (const r of result.reasons) writeError(`  - ${r}`);
            break;
          case 'interview_not_ready':
            writeError(
              'an interview happened and its readiness gate is still blocked — finalize never bypasses it:',
            );
            for (const r of result.gate.reasons) writeError(`  - ${r}`);
            break;
          case 'not_confirmed':
            writeError(
              'the user has not confirmed the intent (2차 게이트, 모드 불변): capture user_confirmation.confirmed=true with their statement and re-run',
            );
            break;
        }
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (format === 'json') {
        writeJson({
          work_item_id: result.intent.work_item_id,
          intent_path: `.ditto/local/work-items/${result.intent.work_item_id}/intent.json`,
          source_digest: result.intent.source_digest,
          autopilot_id: result.autopilot.autopilot_id,
          approval_gate: result.autopilot.approval_gate.status,
          acceptance_criteria: result.intent.acceptance_criteria.map((ac) => ac.id),
          review_coverage: result.state.finalized?.review_coverage ?? [],
        });
      } else {
        writeHuman(`Finalized tech-spec for ${result.intent.work_item_id}`);
        writeHuman(
          `  intent:        .ditto/local/work-items/${result.intent.work_item_id}/intent.json`,
        );
        writeHuman(
          `  source_digest: ${result.intent.source_digest?.sha256.slice(0, 12)}… (${result.intent.source_digest?.doc_path})`,
        );
        writeHuman(
          `  autopilot:     ${result.autopilot.autopilot_id} (gate: ${result.autopilot.approval_gate.status})`,
        );
        writeHuman(
          `  acceptance:    ${result.intent.acceptance_criteria.map((ac) => ac.id).join(', ')}`,
        );
        const cov = result.state.finalized?.review_coverage ?? [];
        const reviewed = cov.filter((c) => c.review === 'reviewed').length;
        writeHuman(
          `  review:        ${reviewed}/${cov.length} sections reviewed (rest pending/skipped — recorded honestly)`,
        );
      }
    } catch (err) {
      writeError(`finalize failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const nextRoundCmd = defineCommand({
  meta: {
    name: 'next-round',
    description:
      'Hand the §6-6 driver this round’s resolved levers + an opt-in cap signal: code enforces only the numeric cap (max_rounds/max_questions, counted from the round trail); the quality levers (threshold/granularity/count_hint) are relayed for the gate agent to obey with judgment, not a mechanical cutoff',
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
      const r = await nextRound(repoRoot, { workItemId: args.workItem });
      if (format === 'json') {
        writeJson(r);
      } else {
        writeHuman(`Round ${r.round} for ${args.workItem}`);
        writeHuman(`  generators:  ${r.generators} (effort: ${r.generator_effort})`);
        writeHuman(
          `  quality dial: threshold ${r.threshold}, granularity ${r.granularity}, count_hint ${r.count_hint} — anchors for the gate, judged not cut`,
        );
        writeHuman(`  gate_mode:   ${r.gate_mode}`);
        writeHuman(
          `  progress:    ${r.rounds_so_far} rounds / ${r.questions_so_far} questions so far`,
        );
        if (r.cap_reached) {
          writeHuman(
            `  CAP REACHED (${r.cap_reason}): stop the question loop — ceiling set by config`,
          );
        } else {
          const caps: string[] = [];
          if (r.max_rounds > 0) caps.push(`rounds≤${r.max_rounds}`);
          if (r.max_questions > 0) caps.push(`questions≤${r.max_questions}`);
          writeHuman(
            `  cap:         ${caps.length ? caps.join(', ') : 'none — score-based termination (dry)'}`,
          );
        }
      }
    } catch (err) {
      writeError(`next-round failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const techSpecCommand = defineCommand({
  meta: {
    name: 'tech-spec',
    description:
      'Drive the tech-spec co-authoring machine (start/record-section/finalize) — doc is the source, intent.json the compile artifact',
  },
  subCommands: {
    start: startCmd,
    'record-section': recordSectionCmd,
    'record-round': recordRoundCmd,
    'next-round': nextRoundCmd,
    finalize: finalizeCmd,
  },
});
