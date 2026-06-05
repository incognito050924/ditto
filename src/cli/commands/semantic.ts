import { join } from 'node:path';
import { defineCommand } from 'citty';
import { applySemanticVerdict, buildSemanticSeed } from '~/acg/semantic/semantic-produce';
import { diffExportedSignatures } from '~/acg/semantic/signature-diff';
import { ensureDir, resolveRepoRootForCreate, writeJson as writeJsonFile } from '~/core/fs';
import { gitShowFile, listChangedFilesVsRef } from '~/core/git';
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
 * wi_260605sg1; this is the missing producer. Three subcommands split the work
 * the dialectic separated:
 *   - `scan`: STATIC layer, automated (O7, wi_260605de1). Reads the git diff vs a
 *     base ref, extracts changed exported signatures with the TS parser, and
 *     auto-seeds the single-change case. Zero is a no-op; multiple fail-close
 *     (the artifact holds one pair — dialectic-1 O1).
 *   - `detect`: STATIC layer, manual. Explicit signature pair in → an `unverified`
 *     seed (the escape hatch when scan can't infer the pair).
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

function isTsSource(path: string): boolean {
  return (path.endsWith('.ts') || path.endsWith('.tsx')) && !path.endsWith('.d.ts');
}

const scanCommand = defineCommand({
  meta: {
    name: 'scan',
    description: 'Auto-detect changed exported signatures vs a git ref and seed (O7)',
  },
  args: {
    'work-item': { type: 'string', description: 'Work item id', required: true },
    base: {
      type: 'string',
      description: 'Git ref to diff against (e.g. HEAD, a sha)',
      required: true,
    },
    file: { type: 'string', description: 'Limit the scan to one path (default: all changed .ts)' },
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
      const base = args.base;
      const files = (args.file ? [args.file] : listChangedFilesVsRef(repoRoot, base)).filter(
        isTsSource,
      );
      // Collect every changed exported signature across the diffed files. The
      // meaning stays unverified — scan only proves the shape changed (O7).
      const changes: Array<{ file: string; symbol: string; before: string; after: string }> = [];
      for (const file of files) {
        const before = gitShowFile(repoRoot, base, file) ?? '';
        const abs = join(repoRoot, file);
        const after = (await Bun.file(abs).exists()) ? await Bun.file(abs).text() : '';
        for (const c of diffExportedSignatures(before, after)) {
          changes.push({ file, symbol: c.symbol, before: c.before, after: c.after });
        }
      }

      if (changes.length === 0) {
        if (format === 'json') {
          writeJson({ work_item_id: args['work-item'], base, changes: 0, seeded: false });
        } else {
          writeHuman(`semantic scan: no exported signature changes vs ${base}`);
        }
        return;
      }

      // Multi-pair fail-closed: the artifact holds ONE change pair (dialectic-1
      // O1). Auto-seeding requires an unambiguous single change; otherwise list
      // them and let the operator narrow with --file (multi-pair is a follow-up).
      if (changes.length > 1) {
        const list = changes.map((c) => `  - ${c.file}: ${c.before} → ${c.after}`).join('\n');
        writeError(
          `semantic scan: ${changes.length} exported signature changes vs ${base}; MVP seeds one pair per work item. Narrow with --file or seed one explicitly with \`ditto semantic detect\`.\n${list}`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }

      const only = changes[0];
      const path = semanticPath(repoRoot, args['work-item']);
      if (await Bun.file(path).exists()) {
        writeError(
          `semantic scan: ${args['work-item']} already has semantic-compatibility.json. Remove it or resolve it with \`ditto semantic verdict\` first.`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const seed = buildSemanticSeed({
        workItemId: args['work-item'],
        file: only.file,
        symbol: only.symbol,
        before: only.before,
        after: only.after,
        producedAt: new Date().toISOString(),
      });
      await ensureDir(join(repoRoot, '.ditto', 'work-items', args['work-item']));
      await writeJsonFile(path, acgSemanticCompatibility, seed);

      if (format === 'json') {
        writeJson({
          work_item_id: args['work-item'],
          base,
          changes: 1,
          seeded: true,
          symbol: only.symbol,
        });
      } else {
        writeHuman(
          `semantic scan: ${only.file} ${only.symbol} "${only.before}" → "${only.after}" seeded (unverified) → semantic-compatibility.json`,
        );
      }
    } catch (err) {
      writeError(`semantic scan failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const semanticCommand = defineCommand({
  meta: {
    name: 'semantic',
    description:
      'SemanticCompatibility producer — scan/detect (seed) / verdict (resolve) (단계6, OBJ-43)',
  },
  subCommands: {
    scan: scanCommand,
    detect: detectCommand,
    verdict: verdictCommand,
  },
});
