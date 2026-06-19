import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  finalizeTechSpec,
  finalizeTechSpecPayload,
  recordRound,
  recordRoundPayload,
  recordSection,
  recordSectionPayload,
  startTechSpec,
} from '~/core/tech-spec';
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
    description: 'Initialize tech-spec-state.json for a work item (doc path + mode)',
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
    if (!(await new WorkItemStore(repoRoot).exists(args.workItem))) {
      writeError(`work item ${args.workItem} not found`);
      process.exit(RUNTIME_ERROR_EXIT);
      return;
    }
    const state = await startTechSpec(repoRoot, {
      workItemId: args.workItem,
      docPath: args.doc,
      mode: args.mode,
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
    finalize: finalizeCmd,
  },
});
