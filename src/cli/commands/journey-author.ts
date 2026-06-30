import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  IdConflictError,
  JourneyReferenceNotFoundError,
  decomposeIntent,
  finalizeAuthoring,
  journeyDraft,
  recordJourney,
  recordStory,
  startAuthoring,
  storyDraft,
} from '~/core/journey-authoring';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto journey-author` — thin citty surface over the n3 journey-authoring core
 * (`~/core/journey-authoring`). Mirrors the tech-spec start/record/finalize shape:
 * the command parses args, validates the payload fail-closed (parseJsonArg + the
 * core's own zod draft schemas), calls the core machine, renders the result, and
 * sets exit codes. No authoring logic lives here — the state machine, conflict
 * gates, and DSL/per-entity compilation are all in core.
 *
 * Two entry points (ac-1) are one command, distinguished by `start --kind`:
 *   - `--kind story`   surface ① story→journey→E2E (user-value first)
 *   - `--kind journey` surface ② journey→E2E (value already fixed)
 */

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
    description:
      'Initialize the journey-authoring working buffer for a work item. --kind picks the entry point: story (① story→journey→E2E) | journey (② journey→E2E)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    kind: {
      type: 'string',
      description: 'Authoring surface: story (①) | journey (②)',
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
    if (args.kind !== 'story' && args.kind !== 'journey') {
      writeError(`--kind must be story|journey; got "${args.kind}"`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      await startAuthoring(repoRoot, { workItemId: args.workItem, kind: args.kind });
      if (format === 'json') {
        writeJson({ work_item_id: args.workItem, kind: args.kind });
      } else {
        writeHuman(`Started journey-authoring for ${args.workItem}`);
        writeHuman(`  surface: ${args.kind === 'story' ? '① story→journey→E2E' : '② journey→E2E'}`);
      }
    } catch (err) {
      writeError(`start failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const recordJourneyCmd = defineCommand({
  meta: {
    name: 'record-journey',
    description:
      'Upsert one journey draft into the working buffer by slug (same slug updates in place). Payload matches the journey draft schema.',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    json: {
      type: 'string',
      description:
        'JSON payload matching the journey draft schema (slug, name, description, owner, intent, surfaces, steps?, implemented?)',
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
    const parsed = journeyDraft.safeParse(raw);
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
      await recordJourney(repoRoot, { workItemId: args.workItem, journey: parsed.data });
      if (format === 'json') {
        writeJson({ work_item_id: args.workItem, recorded_journey_slug: parsed.data.slug });
      } else {
        writeHuman(`Recorded journey draft "${parsed.data.slug}" for ${args.workItem}`);
      }
    } catch (err) {
      writeError(`record-journey failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const recordStoryCmd = defineCommand({
  meta: {
    name: 'record-story',
    description:
      'Set/overwrite the story draft in the working buffer (surface ① only). Payload matches the story draft schema.',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    json: {
      type: 'string',
      description:
        'JSON payload matching the story draft schema (slug, owner, actor, want, value, title?, reference_journey_ids?)',
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
    const parsed = storyDraft.safeParse(raw);
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
      await recordStory(repoRoot, { workItemId: args.workItem, story: parsed.data });
      if (format === 'json') {
        writeJson({ work_item_id: args.workItem, recorded_story_slug: parsed.data.slug });
      } else {
        writeHuman(`Recorded story draft "${parsed.data.slug}" for ${args.workItem}`);
      }
    } catch (err) {
      writeError(`record-story failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const decomposeCmd = defineCommand({
  meta: {
    name: 'decompose',
    description:
      'Propose ordered journey steps from a one-line intent and present them for user review (ac-5). PROPOSAL ONLY — writes nothing and never auto-confirms; the user records the steps they confirm via record-journey.',
  },
  args: {
    intent: {
      type: 'string',
      description: 'One-line user intent to decompose into step drafts',
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
    const draft = decomposeIntent(args.intent);
    if (format === 'json') {
      writeJson(draft);
    } else {
      writeHuman('Proposed step draft (review and confirm — not auto-materialized):');
      for (const s of draft.steps) {
        writeHuman(`  [${s.step_id}] ${s.intent}`);
      }
      writeHuman(`  note: ${draft.note}`);
    }
  },
});

const finalizeCmd = defineCommand({
  meta: {
    name: 'finalize',
    description:
      'Compile the working buffer into ADR-0005 per-entity journey/story files + journey DSL (e2e/journeys/*.md). Fail-closed: every conflict/reference gate runs before any write.',
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
      const result = await finalizeAuthoring(repoRoot, { workItemId: args.workItem });
      if (result.status === 'not_started') {
        writeError(
          'journey-authoring was never started for this work item — run `ditto journey-author start` first',
        );
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (format === 'json') {
        writeJson({
          status: result.status,
          work_item_id: args.workItem,
          journeys: result.journeys.map((j) => j.id),
          story: result.story?.id ?? null,
          dsl_paths: result.dsl_paths,
          superseded: result.superseded,
        });
      } else {
        writeHuman(`Finalized journey-authoring for ${args.workItem}`);
        writeHuman(`  journeys: ${result.journeys.map((j) => j.id).join(', ') || '(none)'}`);
        if (result.story) writeHuman(`  story:    ${result.story.id}`);
        writeHuman(`  dsl:      ${result.dsl_paths.join(', ') || '(none)'}`);
        if (result.superseded.length > 0) {
          writeHuman(`  superseded: ${result.superseded.join(', ')}`);
        }
      }
    } catch (err) {
      // Fail-closed gates surface as runtime errors with their reasons.
      if (err instanceof IdConflictError) {
        writeError('finalize rejected (id conflict, fail-closed):');
        for (const c of err.conflicts) writeError(`  - ${c.id}: ${c.reason}`);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (err instanceof JourneyReferenceNotFoundError) {
        writeError('finalize rejected (referenced journeys not found, fail-closed):');
        for (const m of err.missing) writeError(`  - ${m}`);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      writeError(`finalize failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const journeyAuthorCommand = defineCommand({
  meta: {
    name: 'journey-author',
    description:
      'Drive the journey-authoring machine for the two E2E entry points (start/record-journey/record-story/decompose/finalize) — drafts are the source, per-entity journey/story files + journey DSL the compile artifacts',
  },
  subCommands: {
    start: startCmd,
    'record-journey': recordJourneyCmd,
    'record-story': recordStoryCmd,
    decompose: decomposeCmd,
    finalize: finalizeCmd,
  },
});
