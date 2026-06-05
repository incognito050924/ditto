import { join } from 'node:path';
import { defineCommand } from 'citty';
import { applySemanticVerdict, buildSemanticSeed } from '~/acg/semantic/semantic-produce';
import { ensureDir, resolveRepoRootForCreate, writeJson as writeJsonFile } from '~/core/fs';
import { acgSemanticCompatibility } from '~/schemas/acg-semantic-compatibility';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto semantic` — 단계6 SemanticCompatibility producer (OBJ-43, wi_260605sv1).
 *
 * The consumer gate (stop.ts semanticForcesContinuation) was already wired by
 * wi_260605sg1; this is the missing producer. Two subcommands split the work the
 * dialectic separated:
 *   - `detect`: STATIC layer. Explicit signature pair in → an `unverified` seed.
 *     The seed alone forces continuation, so a signature change cannot silently
 *     clear. MVP is one pair per work item (diff auto-extraction is a follow-up,
 *     wi-semantic-diff-extractor); a second pair fail-closes rather than clobber.
 *   - `verdict`: RESOLVER layer. An agent runs the meaning judgment (ditto never
 *     calls an LLM — ADR-0001) and injects it, clearing the deadlock the seed
 *     would otherwise leave (dialectic-1 O3). yes requires a pinned model_version.
 */

function semanticPath(repoRoot: string, workItem: string): string {
  return join(repoRoot, '.ditto', 'work-items', workItem, 'semantic-compatibility.json');
}

const detectCommand = defineCommand({
  meta: {
    name: 'detect',
    description: 'Seed an unverified SemanticCompatibility from an explicit signature pair (단계6)',
  },
  args: {
    'work-item': { type: 'string', description: 'Work item id', required: true },
    file: { type: 'string', description: 'File declaring the changed symbol', required: true },
    symbol: { type: 'string', description: 'Changed exported symbol name', required: true },
    before: { type: 'string', description: 'Signature before the change', required: true },
    after: { type: 'string', description: 'Signature after the change', required: true },
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
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const path = semanticPath(repoRoot, args['work-item']);
      // Multi-pair fail-closed: the artifact holds ONE change pair, so a second
      // detect would clobber the first into a silent false pass (dialectic-1 O1).
      if (await Bun.file(path).exists()) {
        writeError(
          `semantic detect: ${args['work-item']} already has semantic-compatibility.json. MVP supports one signature pair per work item; multi-pair detection is a follow-up (wi-semantic-diff-extractor). Remove it or resolve it with \`ditto semantic verdict\` first.`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const seed = buildSemanticSeed({
        workItemId: args['work-item'],
        file: args.file,
        symbol: args.symbol,
        before: args.before,
        after: args.after,
        producedAt: new Date().toISOString(),
      });
      await ensureDir(join(repoRoot, '.ditto', 'work-items', args['work-item']));
      await writeJsonFile(path, acgSemanticCompatibility, seed);

      if (format === 'json') {
        writeJson({ work_item_id: args['work-item'], semantic_safe: 'unverified', seeded: true });
      } else {
        writeHuman(
          `semantic detect: ${args.file} ${args.symbol} "${args.before}" → "${args.after}" seeded (unverified) → semantic-compatibility.json`,
        );
      }
    } catch (err) {
      writeError(`semantic detect failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const SAFE_VALUES = ['yes', 'no', 'unverified'] as const;

const verdictCommand = defineCommand({
  meta: {
    name: 'verdict',
    description: "Inject an agent's meaning judgment onto a seed to resolve it (단계6 resolver)",
  },
  args: {
    'work-item': { type: 'string', description: 'Work item id', required: true },
    'semantic-safe': { type: 'string', description: 'yes|no|unverified', required: true },
    'old-meaning': { type: 'string', description: 'Real domain meaning (required for yes/no)' },
    'intended-breaking': {
      type: 'boolean',
      description: 'Declare a no verdict an intended break (clears the gate)',
    },
    compatibility: { type: 'string', description: 'compatible|additive|breaking' },
    'model-version': {
      type: 'string',
      description: 'Pinned judge model id — required when semantic-safe=yes',
    },
    'type-safe': { type: 'boolean', description: 'Override the type-safety judgment' },
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
    const safe = args['semantic-safe'];
    if (!SAFE_VALUES.includes(safe as (typeof SAFE_VALUES)[number])) {
      writeError(`semantic verdict: --semantic-safe must be one of ${SAFE_VALUES.join('|')}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const compatibility = args.compatibility as 'compatible' | 'additive' | 'breaking' | undefined;
    if (compatibility && !['compatible', 'additive', 'breaking'].includes(compatibility)) {
      writeError('semantic verdict: --compatibility must be compatible|additive|breaking');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const path = semanticPath(repoRoot, args['work-item']);
      if (!(await Bun.file(path).exists())) {
        writeError(
          `semantic verdict: no seed for ${args['work-item']}. Run \`ditto semantic detect\` first.`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const seed = acgSemanticCompatibility.parse(JSON.parse(await Bun.file(path).text()));
      const resolved = applySemanticVerdict(seed, {
        semanticSafe: safe as (typeof SAFE_VALUES)[number],
        oldMeaning: args['old-meaning'],
        compatibility,
        intendedBreaking: args['intended-breaking'],
        typeSafe: args['type-safe'],
        modelVersion: args['model-version'],
      });
      // writeJson re-validates → an unsubstantiated yes (no model_version) or a
      // left-over sentinel old_meaning fails closed here (dialectic-1 O4/O5).
      await writeJsonFile(path, acgSemanticCompatibility, resolved);

      if (format === 'json') {
        writeJson({
          work_item_id: args['work-item'],
          semantic_safe: resolved.verdict.semantic_safe,
          intended_breaking: resolved.verdict.intended_breaking ?? false,
        });
      } else {
        writeHuman(
          `semantic verdict: ${args['work-item']} → semantic_safe=${resolved.verdict.semantic_safe}` +
            `${resolved.verdict.intended_breaking ? ' (intended break)' : ''} → semantic-compatibility.json`,
        );
      }
    } catch (err) {
      writeError(`semantic verdict failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const semanticCommand = defineCommand({
  meta: {
    name: 'semantic',
    description:
      'SemanticCompatibility producer — detect (seed) / verdict (resolve) (단계6, OBJ-43)',
  },
  subCommands: {
    detect: detectCommand,
    verdict: verdictCommand,
  },
});
