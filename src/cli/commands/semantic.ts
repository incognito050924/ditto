import { defineCommand } from 'citty';
import {
  buildScanObservation,
  computeScanFingerprint,
  workItemBaseCandidates,
} from '~/acg/semantic/scan-observation';
import { applySemanticVerdict, buildSemanticSeed } from '~/acg/semantic/semantic-produce';
import { scanSignatureChanges } from '~/acg/semantic/signature-codeql';
import { makeRelationDeps } from '~/core/codeql/host-deps';
import type { CodeqlLanguage } from '~/core/codeql/runner';
import { localDir } from '~/core/ditto-paths';
import { ensureDir, resolveRepoRootForCreate, writeJson as writeJsonFile } from '~/core/fs';
import { diffVsRef, gitRevParse } from '~/core/git';
import { pickBaseRef } from '~/core/work-item-handoff';
import { WorkItemStore } from '~/core/work-item-store';
import { acgSemanticCompatibility } from '~/schemas/acg-semantic-compatibility';
import { acgSemanticScanObservation } from '~/schemas/acg-semantic-scan-observation';
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
 *   - `scan`: STATIC layer, automated (O7, wi_260605de1). Diffs exported
 *     signatures between a base ref and the working tree via CodeQL (ADR-0006
 *     fact extraction, not a language compiler) and auto-seeds the single-change
 *     case. Zero is a no-op; multiple fail-close (one pair per artifact — O1).
 *   - `detect`: STATIC layer, manual. Explicit signature pair in → an `unverified`
 *     seed (the escape hatch when scan can't infer the pair, e.g. an unbound language).
 *   - `verdict`: RESOLVER layer. An agent runs the meaning judgment (ditto never
 *     calls an LLM — ADR-0001) and injects it, clearing the deadlock the seed
 *     would otherwise leave (dialectic-1 O3). yes requires a pinned model_version.
 */

function semanticPath(repoRoot: string, workItem: string): string {
  return localDir(repoRoot, 'work-items', workItem, 'semantic-compatibility.json');
}

function observationPath(repoRoot: string, workItem: string): string {
  return localDir(repoRoot, 'work-items', workItem, 'semantic-scan-observation.json');
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
      // Multi-pair (G4): a second detect APPENDS its pair to the existing artifact
      // so every detected change reaches the gate. A duplicate pair (same
      // before/after) is rejected — re-seeding would clobber a resolved verdict.
      const seed = buildSemanticSeed({
        workItemId: args['work-item'],
        changes: [{ before: args.before, after: args.after }],
        producedAt: new Date().toISOString(),
      });
      let artifact = seed;
      if (await Bun.file(path).exists()) {
        const prior = acgSemanticCompatibility.parse(JSON.parse(await Bun.file(path).text()));
        const dup = prior.changes.some((c) => c.before === args.before && c.after === args.after);
        if (dup) {
          writeError(
            `semantic detect: ${args['work-item']} already has "${args.before}" → "${args.after}". Resolve it with \`ditto semantic verdict\` instead of re-seeding.`,
          );
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        artifact = { ...prior, changes: [...prior.changes, ...seed.changes] };
      }
      await ensureDir(localDir(repoRoot, 'work-items', args['work-item']));
      await writeJsonFile(path, acgSemanticCompatibility, artifact);

      if (format === 'json') {
        writeJson({
          work_item_id: args['work-item'],
          semantic_safe: 'unverified',
          seeded: true,
          changes: artifact.changes.length,
        });
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
    before: {
      type: 'string',
      description: 'Signature before — selects which pair to resolve (required when >1 pair)',
    },
    after: {
      type: 'string',
      description: 'Signature after — selects which pair to resolve (required when >1 pair)',
    },
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
    'characterization-test': {
      type: 'string',
      description:
        'Ref to a passing behavior/characterization test — required for an agent yes (witnesses the preserved meaning)',
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
      if ((args.before === undefined) !== (args.after === undefined)) {
        writeError('semantic verdict: --before and --after must be given together');
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const target =
        args.before !== undefined && args.after !== undefined
          ? { before: args.before, after: args.after }
          : undefined;
      const resolved = applySemanticVerdict(seed, {
        semanticSafe: safe as (typeof SAFE_VALUES)[number],
        ...(args['old-meaning'] !== undefined ? { oldMeaning: args['old-meaning'] } : {}),
        ...(compatibility !== undefined ? { compatibility } : {}),
        ...(args['intended-breaking'] !== undefined
          ? { intendedBreaking: args['intended-breaking'] }
          : {}),
        ...(args['type-safe'] !== undefined ? { typeSafe: args['type-safe'] } : {}),
        ...(args['model-version'] !== undefined ? { modelVersion: args['model-version'] } : {}),
        ...(args['characterization-test'] !== undefined
          ? { characterizationTestRef: args['characterization-test'] }
          : {}),
        ...(target ? { target } : {}),
      });
      // writeJson re-validates → an unsubstantiated yes (no model_version) or a
      // left-over sentinel old_meaning fails closed here (dialectic-1 O4/O5).
      await writeJsonFile(path, acgSemanticCompatibility, resolved);

      // Report the pair just resolved (the sole pair when no target was given).
      const resolvedChange = target
        ? resolved.changes.find((c) => c.before === target.before && c.after === target.after)
        : resolved.changes[0];
      const resolvedVerdict = resolvedChange?.verdict;
      if (format === 'json') {
        writeJson({
          work_item_id: args['work-item'],
          semantic_safe: resolvedVerdict?.semantic_safe,
          intended_breaking: resolvedVerdict?.intended_breaking ?? false,
        });
      } else {
        writeHuman(
          `semantic verdict: ${args['work-item']} → semantic_safe=${resolvedVerdict?.semantic_safe}` +
            `${resolvedVerdict?.intended_breaking ? ' (intended break)' : ''} → semantic-compatibility.json`,
        );
      }
    } catch (err) {
      writeError(`semantic verdict failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const scanCommand = defineCommand({
  meta: {
    name: 'scan',
    description:
      'Auto-detect changed exported signatures vs a git ref via CodeQL and seed (O7, ADR-0006)',
  },
  args: {
    'work-item': { type: 'string', description: 'Work item id', required: true },
    base: {
      type: 'string',
      description: 'Git ref to diff against (e.g. HEAD, a sha)',
      required: true,
    },
    language: {
      type: 'string',
      description: 'CodeQL language (default javascript). Unbound languages fail loud.',
    },
    'source-root': { type: 'string', description: 'Source root relative to repo (default src)' },
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
      const language = (args.language ?? 'javascript') as CodeqlLanguage;
      // 컴파일 언어의 관계추출은 buildless로 충분(relations probe 실증) — Java는 none 강제.
      const buildMode = language === 'java' ? ('none' as const) : undefined;
      const changes = await scanSignatureChanges(
        {
          repoRoot,
          baseRef: args.base,
          language,
          sourceRootRel: args['source-root'] ?? 'src',
          ...(buildMode ? { buildMode } : {}),
        },
        makeRelationDeps(),
      );

      if (changes.length === 0) {
        if (format === 'json') {
          writeJson({
            work_item_id: args['work-item'],
            base: args.base,
            changes: 0,
            seeded: false,
          });
        } else {
          writeHuman(`semantic scan: no exported signature changes vs ${args.base}`);
        }
        return;
      }
      // Multi-pair (G4): the artifact carries EVERY detected pair so all reach the
      // gate. An existing artifact fail-closes — scan is the fresh-seed path; a
      // re-scan after partial resolution would clobber verdicts (resolve or remove
      // first, or use `ditto semantic detect` to add a pair).
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
        changes: changes.map((c) => ({ before: c.before, after: c.after })),
        producedAt: new Date().toISOString(),
      });
      await ensureDir(localDir(repoRoot, 'work-items', args['work-item']));
      await writeJsonFile(path, acgSemanticCompatibility, seed);

      if (format === 'json') {
        writeJson({
          work_item_id: args['work-item'],
          base: args.base,
          changes: changes.length,
          seeded: true,
        });
      } else {
        const list = changes
          .map((c) => `  - ${c.file} ${c.symbol} "${c.before}" → "${c.after}"`)
          .join('\n');
        writeHuman(
          `semantic scan: ${changes.length} exported signature change(s) seeded (unverified) → semantic-compatibility.json\n${list}`,
        );
      }
    } catch (err) {
      writeError(`semantic scan failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const observeCommand = defineCommand({
  meta: {
    name: 'observe',
    description:
      'Record changed exported signatures vs a ref to a NON-gated observation (O2/O8, S2)',
  },
  args: {
    'work-item': { type: 'string', description: 'Work item id', required: true },
    base: {
      type: 'string',
      description: 'Git ref to diff against (default: work item start sha → origin/main → main)',
    },
    language: { type: 'string', description: 'CodeQL language (default javascript)' },
    'source-root': { type: 'string', description: 'Source root relative to repo (default src)' },
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
      const language = (args.language ?? 'javascript') as CodeqlLanguage;
      const sourceRootRel = args['source-root'] ?? 'src';
      // base fallback (dialectic-1 OBJ-4): explicit --base, else the work item's
      // start sha, else origin/main → main. base_used records the resolved ref.
      let base = args.base;
      if (!base) {
        const workItem = await new WorkItemStore(repoRoot).get(args['work-item']);
        const resolved = pickBaseRef(repoRoot, workItemBaseCandidates(workItem));
        if (!resolved) {
          writeError(
            `semantic observe: no --base and no fallback ref resolved for ${args['work-item']} (started_at_sha/origin/main/main). Pass --base explicitly.`,
          );
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        base = resolved;
      }
      const baseSha = gitRevParse(repoRoot, base);
      const fingerprint = computeScanFingerprint(baseSha, diffVsRef(repoRoot, base));
      const path = observationPath(repoRoot, args['work-item']);

      // Fingerprint skip: an unchanged tree (vs the same base) reuses the prior
      // observation rather than rebuilding CodeQL DBs (dialectic-1 OBJ-1).
      if (await Bun.file(path).exists()) {
        const prior = acgSemanticScanObservation.safeParse(JSON.parse(await Bun.file(path).text()));
        if (prior.success && prior.data.fingerprint === fingerprint) {
          if (format === 'json') {
            writeJson({ work_item_id: args['work-item'], skipped: true, reason: 'unchanged' });
          } else {
            writeHuman(`semantic observe: unchanged vs ${base} (fingerprint match) — skipped`);
          }
          return;
        }
      }

      const buildMode = language === 'java' ? ('none' as const) : undefined;
      const changes = await scanSignatureChanges(
        {
          repoRoot,
          baseRef: base,
          language,
          sourceRootRel,
          ...(buildMode ? { buildMode } : {}),
        },
        makeRelationDeps(),
      );
      // Non-gated: records ALL changes (multi-change OK — this is a list, not the
      // single-`change` blocking artifact). Stop never reads this (dialectic-1 O3/O5).
      const observation = buildScanObservation({
        workItemId: args['work-item'],
        baseUsed: base,
        language,
        sourceRoot: sourceRootRel,
        fingerprint,
        changes,
        producedAt: new Date().toISOString(),
      });
      await ensureDir(localDir(repoRoot, 'work-items', args['work-item']));
      await writeJsonFile(path, acgSemanticScanObservation, observation);

      if (format === 'json') {
        writeJson({
          work_item_id: args['work-item'],
          base,
          change_count: observation.change_count,
          seeded: false,
        });
      } else {
        writeHuman(
          `semantic observe: ${observation.change_count} exported signature change(s) vs ${base} → semantic-scan-observation.json (non-blocking)`,
        );
      }
    } catch (err) {
      writeError(`semantic observe failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const semanticCommand = defineCommand({
  meta: {
    name: 'semantic',
    description:
      'SemanticCompatibility producer — scan/observe (produce) / detect / verdict (단계6, OBJ-43)',
  },
  subCommands: {
    scan: scanCommand,
    observe: observeCommand,
    detect: detectCommand,
    verdict: verdictCommand,
  },
});
