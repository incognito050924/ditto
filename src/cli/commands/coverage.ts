import { defineCommand } from 'citty';
import { type DiscoveryCandidate, admitDiscoveredCategories } from '~/core/coverage-discovery';
import { CoverageFeedbackLedger, recordResidual, recurrenceCounts } from '~/core/coverage-feedback';
import { attributeCoverageEscape, suggestCoverageFeedback } from '~/core/coverage-feedback';
import { CoverageStore } from '~/core/coverage-store';
import {
  CATEGORY_NODE_PREFIX,
  FAR_FIELD_TAXONOMY_FLOOR,
  applyTaxonomyMutation,
  loadFarFieldTaxonomy,
  warnMalformedTaxonomy,
} from '~/core/coverage-taxonomy';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  DEFAULT_COVERAGE_DISPOSITION,
  coverageDisposition,
  coverageFeedback,
  isFarFieldEscape,
} from '~/schemas/coverage';
import type { CoverageDisposition, CoverageFeedbackEntry } from '~/schemas/coverage';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto coverage feedback` — ac-11b outcome loop entry point. Validate a manual
 * coverage-escape report, run the structural attribution GUARD
 * (`attributeCoverageEscape`) off the SAME coverage.json the far-field verdict
 * reads, and — only when accepted — append one row to the cross-wi jsonl ledger.
 * A rejected report (not a floor escape: still-open category, a non-floor node, an
 * unseeded floor category) records NOTHING and exits non-zero (ac-2). The CLI is a
 * thin surface: it validates, calls the core guard + ledger, renders, and injects
 * `recorded_at` (the ledger keeps the clock out of core for determinism).
 */
const coverageFeedbackCommand = defineCommand({
  meta: {
    name: 'feedback',
    description: 'Attribute a coverage escape (depth/breadth) and record it to the ledger (ac-11b)',
  },
  // The three inputs are validated by `coverageFeedback` (zod) inside run, not by
  // citty's required-flag — so a missing field renders a schema usage error (exit
  // 65) instead of citty's bare exit 1, keeping one validation gate.
  args: {
    wi: { type: 'string', description: 'Work item id (wi_*) the escape was found in' },
    category: {
      type: 'string',
      description: 'Coverage category the escape belongs to (floor id or cov-cat-*)',
    },
    evidence: {
      type: 'string',
      description: 'Triggering-failure evidence — what slipped past coverage',
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
    const parsed = coverageFeedback.safeParse({
      work_item_id: args.wi,
      category_id: args.category,
      evidence: args.evidence,
    });
    if (!parsed.success) {
      writeError('coverage feedback input failed schema validation:');
      for (const issue of parsed.error.issues) {
        writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const input = parsed.data;
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const store = new CoverageStore(repoRoot);
      const attribution = await attributeCoverageEscape(store, input);
      if (!attribution.accepted) {
        // Rejected → record NOTHING (ac-2). Surface the structural reason and exit
        // non-zero so a caller can tell an escape from a non-escape.
        if (format === 'json') {
          writeJson({
            work_item_id: input.work_item_id,
            category_id: input.category_id,
            accepted: false,
            reason: attribution.reason,
          });
        } else {
          writeHuman(`coverage feedback REJECTED (not a floor escape): ${attribution.reason}`);
          writeHuman('  → nothing recorded.');
        }
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      // accepted — fault_kind is set by the guard (gate and score from one state).
      const faultKind = attribution.fault_kind;
      if (faultKind === undefined) {
        // Defensive: the guard sets fault_kind on every accept; never expected.
        writeError('attribution accepted without a fault_kind — refusing to record');
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      const ledger = new CoverageFeedbackLedger(repoRoot);
      const entry = await ledger.append(
        {
          work_item_id: input.work_item_id,
          category_id: input.category_id,
          fault_kind: faultKind,
          evidence: input.evidence,
        },
        new Date().toISOString(),
      );
      if (format === 'json') {
        writeJson({
          work_item_id: entry.work_item_id,
          category_id: entry.category_id,
          accepted: true,
          fault_kind: entry.fault_kind,
          recorded_at: entry.recorded_at,
        });
      } else {
        writeHuman(
          `coverage feedback recorded: ${entry.category_id} [${entry.fault_kind}] for ${entry.work_item_id}`,
        );
        writeHuman(`  evidence: ${entry.evidence}`);
      }
    } catch (err) {
      writeError(`coverage feedback failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto coverage residual` — record a general followup / residual-risk row that
 * is NOT a far-field escape (ac-3, wi_26062257r). Unlike `feedback`, it does NOT
 * run the far-field structural guard: a residual is not a floor escape, so there
 * is no depth/breadth attribution to make. It is appended to the SAME ledger with
 * `fault_kind: 'residual'` so it is kept and visible to `readAll`, yet the
 * far-field cost aggregation (`recurrenceCounts` / `propose`) excludes it. The CLI
 * is a thin surface: validate the same three inputs, call the core recorder, and
 * inject `recorded_at` (the clock stays out of core for determinism).
 */
const coverageResidualCommand = defineCommand({
  meta: {
    name: 'residual',
    description:
      'Record a general followup / residual-risk row (NOT a far-field escape; excluded from far-field cost stats, ac-3)',
  },
  args: {
    wi: { type: 'string', description: 'Work item id (wi_*) the residual risk belongs to' },
    category: {
      type: 'string',
      description: 'Category / area the residual risk belongs to',
    },
    evidence: {
      type: 'string',
      description: 'The followup / residual-risk text',
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
    const parsed = coverageFeedback.safeParse({
      work_item_id: args.wi,
      category_id: args.category,
      evidence: args.evidence,
    });
    if (!parsed.success) {
      writeError('coverage residual input failed schema validation:');
      for (const issue of parsed.error.issues) {
        writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const input = parsed.data;
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const ledger = new CoverageFeedbackLedger(repoRoot);
      const entry = await recordResidual(ledger, input, new Date().toISOString());
      if (format === 'json') {
        writeJson({
          work_item_id: entry.work_item_id,
          category_id: entry.category_id,
          fault_kind: entry.fault_kind,
          recorded_at: entry.recorded_at,
        });
      } else {
        writeHuman(
          `coverage residual recorded: ${entry.category_id} [${entry.fault_kind}] for ${entry.work_item_id}`,
        );
        writeHuman(`  evidence: ${entry.evidence}`);
        writeHuman('  → excluded from far-field cost/escape stats.');
      }
    } catch (err) {
      writeError(`coverage residual failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/** Map a (possibly cov-cat- prefixed) ledger category_id to its bare floor id. */
function bareFloorId(categoryId: string): string {
  return categoryId.startsWith(CATEGORY_NODE_PREFIX)
    ? categoryId.slice(CATEGORY_NODE_PREFIX.length)
    : categoryId;
}

/** One augmentation candidate surfaced by `coverage propose`. */
interface ProposeCandidate {
  category_id: string;
  /** Floor probing-question lens, or — for a breadth (non-floor) escape — the first triggering evidence. */
  lens: string;
  /** depth = under-probed existing lens; breadth = missing lens (last recorded for the category). */
  fault_kind: string;
  /** Every triggering-failure evidence recorded for this category (in ledger order). */
  evidence: string[];
  /** How many ledger rows this category has (ac-4 recurrence). */
  recurrence: number;
}

/**
 * `ditto coverage propose` — read the cross-wi feedback ledger back and surface
 * per-category AUGMENTATION CANDIDATES (ac-3): for each category that escaped,
 * print its lens (the floor probing-question when it is a floor category; the
 * triggering evidence when the floor never seeded it — a missing lens), the
 * triggering-failure evidence, the fault kind (depth/breadth), and the recurrence
 * count. This is OUTPUT ONLY — it does NOT mutate the taxonomy or auto-classify;
 * the human decides what to add. `--wi` filters the ledger to one work item.
 */
const coverageProposeCommand = defineCommand({
  meta: {
    name: 'propose',
    description:
      'Surface taxonomy-augmentation candidates from the feedback ledger (lens + evidence + fault + recurrence, ac-3)',
  },
  args: {
    wi: {
      type: 'string',
      description: 'Filter the ledger to one work item id (omit for the whole ledger)',
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
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const all = await new CoverageFeedbackLedger(repoRoot).readAll();
      const wiFiltered = args.wi ? all.filter((e) => e.work_item_id === args.wi) : all;
      // `propose` surfaces FAR-FIELD taxonomy-augmentation candidates, so it reads
      // only far-field escapes (depth/breadth) and excludes residual rows — those
      // are recorded but never feed the far-field cost/escape judgement (ac-3).
      const entries = wiFiltered.filter((e) => isFarFieldEscape(e.fault_kind));
      const counts = recurrenceCounts(entries);
      const floorLens = new Map(FAR_FIELD_TAXONOMY_FLOOR.map((c) => [c.id, c.lens]));

      // Group by category, preserving ledger order of first appearance and evidence.
      const order: string[] = [];
      const byCat = new Map<string, CoverageFeedbackEntry[]>();
      for (const e of entries) {
        if (!byCat.has(e.category_id)) {
          byCat.set(e.category_id, []);
          order.push(e.category_id);
        }
        byCat.get(e.category_id)?.push(e);
      }

      const candidates: ProposeCandidate[] = order.map((categoryId) => {
        const rows = byCat.get(categoryId) ?? [];
        const evidence = rows.map((r) => r.evidence);
        // The fault_kind is structural per category; use the last recorded row.
        const faultKind = rows[rows.length - 1]?.fault_kind ?? 'breadth';
        const seededLens = floorLens.get(bareFloorId(categoryId));
        // Floor category → its probing-question lens. Missing lens (breadth, not in
        // floor) → fall back to the triggering evidence (there is no seeded lens yet).
        const lens = seededLens ?? evidence[0] ?? '';
        return {
          category_id: categoryId,
          lens,
          fault_kind: faultKind,
          evidence,
          recurrence: counts.get(categoryId) ?? rows.length,
        };
      });

      if (format === 'json') {
        writeJson({ candidates });
        return;
      }
      if (candidates.length === 0) {
        writeHuman('coverage propose: ledger empty — no augmentation candidates.');
        return;
      }
      writeHuman(`coverage propose: ${candidates.length} augmentation candidate(s)`);
      for (const c of candidates) {
        writeHuman(`  [${c.fault_kind}] ${c.category_id} (recurrence ${c.recurrence})`);
        writeHuman(`    lens: ${c.lens}`);
        for (const ev of c.evidence) writeHuman(`    - ${ev}`);
      }
    } catch (err) {
      writeError(`coverage propose failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto coverage suggest` — when a verify node fails and the failure may be a
 * coverage MISS (a dry-closed category judged safe yet broke), surface a
 * copy-paste `ditto coverage feedback` template the user can run to record the
 * escape (ac-3, wi_260622kb4). SUGGEST ONLY: it reads the work item's
 * coverage.json (the SAME map the far-field verdict reads) and, for each dry-closed
 * (resolved) floor category, emits a feedback command line with a placeholder
 * evidence the user fills in. It records NOTHING, classifies NOTHING automatically,
 * and never mutates the ledger — the user decides whether to run a template. The
 * "verify fail" signal is NOT auto-hooked; the user invokes this manually (and may
 * pass the failing `--node` for context only).
 *
 * When coverage.json is ABSENT (the common small-change case — no plan-stage
 * far-field sweep ran), there is no coverage data to attribute against, so the
 * command prints a hint to enable the sweep and re-run, with no suggestions.
 */
const coverageSuggestCommand = defineCommand({
  meta: {
    name: 'suggest',
    description:
      'Suggest `coverage feedback` templates for a verify failure that may be a coverage miss (suggest only, ac-3)',
  },
  args: {
    wi: { type: 'string', description: 'Work item id (wi_*) whose coverage map to read' },
    node: {
      type: 'string',
      description: 'The failing verify node id, for context only (not auto-hooked)',
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
    if (!args.wi) {
      writeError('coverage suggest requires --wi <wi_*>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const wi = args.wi;
    const failedNode = args.node ?? null;
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const store = new CoverageStore(repoRoot);
      if (!(await store.exists(wi))) {
        const hint =
          'no coverage.json for this work item — the plan-stage far-field sweep did not run (no design node / small change). Enable the sweep and re-run plan to get coverage data to attribute against.';
        if (format === 'json') {
          writeJson({
            work_item_id: wi,
            failed_node: failedNode,
            coverage_present: false,
            suggestions: [],
            hint,
          });
        } else {
          writeHuman(`coverage suggest: ${hint}`);
        }
        return;
      }
      const map = await store.getMap(wi);
      const suggestions = suggestCoverageFeedback(map, wi);
      if (format === 'json') {
        writeJson({
          work_item_id: wi,
          failed_node: failedNode,
          coverage_present: true,
          suggestions,
        });
        return;
      }
      if (suggestions.length === 0) {
        writeHuman(
          'coverage suggest: no dry-closed (resolved) floor categories — nothing to attribute a verify failure to.',
        );
        return;
      }
      writeHuman(
        `coverage suggest: ${suggestions.length} dry-closed categor${suggestions.length === 1 ? 'y' : 'ies'} a verify failure could be a miss in.`,
      );
      writeHuman('  Fill in the evidence and run one to record (it does NOT record for you):');
      for (const s of suggestions) {
        writeHuman(`  [${s.fault_kind}] ${s.category_id} — ${s.lens}`);
        writeHuman(`    ${s.template}`);
      }
    } catch (err) {
      writeError(`coverage suggest failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * Load the project's EFFECTIVE far-field taxonomy (floor + tier-② overrides) and
 * warn (never silently) if the override file is malformed — so every taxonomy CLI
 * command surfaces a bad `.ditto/coverage-taxonomy.json` the same way the live
 * readers do (ac-1/ac-3). The pure merge lives in `resolveTaxonomy`;
 * `loadFarFieldTaxonomy` is the single I/O entry point.
 */
async function loadEffectiveTaxonomy(repoRoot: string) {
  return loadFarFieldTaxonomy(repoRoot, () => warnMalformedTaxonomy(repoRoot));
}

/**
 * The KNOWN category universe = every floor id ∪ every effective id (which already
 * folds in project-added ids). `add` rejects an id already IN this set (a duplicate,
 * sweep #6); `disable`/`reroute` reject an id NOT in it (a typo'd target would be a
 * silent no-op, sweep #4). Floor ids come from the constant so a DISABLED floor id
 * still counts as known.
 */
function taxonomyUniverse(effective: readonly { id: string }[]): Set<string> {
  return new Set<string>([
    ...FAR_FIELD_TAXONOMY_FLOOR.map((c) => c.id),
    ...effective.map((c) => c.id),
  ]);
}

/**
 * Validate an optional `--disposition` value against the enum. Returns the parsed
 * route, `undefined` when absent, or `null` when present-but-invalid (the caller
 * renders a usage error). Kept separate from citty's arg layer so a bad value is a
 * clean exit-65 usage error, not citty's bare exit 1.
 */
function parseDispositionArg(value: string | undefined): CoverageDisposition | undefined | null {
  if (value === undefined) return undefined;
  const parsed = coverageDisposition.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * `ditto coverage list` — print the EFFECTIVE far-field taxonomy (the code floor
 * merged with the tier-② `.ditto/coverage-taxonomy.json` override via
 * `resolveTaxonomy`, ac-1), annotating each active entry as `floor` (unchanged),
 * `added` (a project category / a floor lens overridden), or `rerouted` (a floor
 * category whose disposition the project changed), and listing separately the floor
 * categories the project `disabled`. Read-only. A malformed override warns here too
 * (fail-open to the floor WITH a signal).
 */
const coverageTaxonomyListCommand = defineCommand({
  meta: {
    name: 'list',
    description:
      'Print the effective far-field taxonomy (floor + tier-② overrides), marking floor / added / rerouted / disabled (ac-1)',
  },
  args: {
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
      const effective = await loadEffectiveTaxonomy(repoRoot);
      const floorById = new Map(FAR_FIELD_TAXONOMY_FLOOR.map((c) => [c.id, c]));
      const effectiveIds = new Set(effective.map((c) => c.id));
      const entries = effective.map((c) => {
        const floor = floorById.get(c.id);
        const disposition = c.disposition ?? DEFAULT_COVERAGE_DISPOSITION;
        let status: 'floor' | 'added' | 'rerouted';
        if (!floor || c.lens !== floor.lens) {
          // Not a floor id, or a floor id whose lens the project overrode.
          status = 'added';
        } else if (disposition !== (floor.disposition ?? DEFAULT_COVERAGE_DISPOSITION)) {
          status = 'rerouted';
        } else {
          status = 'floor';
        }
        return { id: c.id, lens: c.lens, disposition, status };
      });
      // A floor id absent from the effective set was turned off (resolveTaxonomy only
      // drops a floor entry when it is disabled or overridden — an override keeps the id).
      const disabled = FAR_FIELD_TAXONOMY_FLOOR.filter((c) => !effectiveIds.has(c.id)).map((c) => ({
        id: c.id,
        lens: c.lens,
        disposition: c.disposition ?? DEFAULT_COVERAGE_DISPOSITION,
      }));
      if (format === 'json') {
        writeJson({ entries, disabled });
        return;
      }
      writeHuman(
        `coverage taxonomy: ${entries.length} active categor${entries.length === 1 ? 'y' : 'ies'}`,
      );
      for (const e of entries) {
        writeHuman(`  [${e.status}] ${e.id} (${e.disposition})`);
        writeHuman(`    ${e.lens}`);
      }
      if (disabled.length > 0) {
        writeHuman(
          `  ${disabled.length} disabled floor categor${disabled.length === 1 ? 'y' : 'ies'}:`,
        );
        for (const d of disabled) writeHuman(`  [disabled] ${d.id}`);
      }
    } catch (err) {
      writeError(`coverage list failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto coverage add` — add a project far-field category (id + probing-question
 * lens, ac-1 shape) to the tier-② override via `applyTaxonomyMutation` (ac-2). The
 * id is rejected if it already names a known category (floor or project-added) — a
 * duplicate id would seed two coverage nodes with the same id (sweep #6). An
 * optional `--disposition` routes the category; absent = DEFAULT_COVERAGE_DISPOSITION.
 */
const coverageTaxonomyAddCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Add a project far-field category to the tier-② taxonomy override (ac-2)',
  },
  args: {
    id: { type: 'string', description: 'Category id (kebab-case)' },
    lens: { type: 'string', description: 'Probing-question lens the sweep answers (ac-1)' },
    disposition: {
      type: 'string',
      description: 'Route: code-verify|user-intent|runtime-post-impl (default code-verify)',
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
    const id = args.id ? bareFloorId(args.id.trim()) : '';
    if (!id || !args.lens) {
      writeError('coverage add requires --id <kebab-id> and --lens <probing question>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const disposition = parseDispositionArg(args.disposition);
    if (disposition === null) {
      writeError(
        `invalid --disposition "${args.disposition}"; expected one of: code-verify, user-intent, runtime-post-impl`,
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const effective = await loadEffectiveTaxonomy(repoRoot);
      if (taxonomyUniverse(effective).has(id)) {
        writeError(
          `coverage add: category '${id}' already exists (floor or project-added) — pick a new id, or use 'coverage reroute'/'coverage disable'`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const result = await applyTaxonomyMutation(repoRoot, {
        kind: 'add',
        id,
        lens: args.lens,
        ...(disposition ? { disposition } : {}),
      });
      if (format === 'json') {
        writeJson({
          added: id,
          disposition: disposition ?? DEFAULT_COVERAGE_DISPOSITION,
          path: result.path,
        });
      } else {
        writeHuman(
          `coverage taxonomy: added '${id}' (${disposition ?? DEFAULT_COVERAGE_DISPOSITION})`,
        );
        writeHuman(`  → ${result.path}`);
      }
    } catch (err) {
      writeError(`coverage add failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto coverage disable` — turn off a floor category for this project via
 * `applyTaxonomyMutation` (ac-2). REQUIRES `--reason` (stored in
 * `disabled_reasons[id]` so a removal is never silent, ac-4). The target must be a
 * known category (floor ∪ project-added); a typo'd id is rejected rather than
 * silently doing nothing (sweep #4).
 */
const coverageTaxonomyDisableCommand = defineCommand({
  meta: {
    name: 'disable',
    description:
      'Disable a floor far-field category for this project, with a recorded reason (ac-2)',
  },
  args: {
    id: { type: 'string', description: 'Floor category id to disable' },
    reason: { type: 'string', description: 'Why this category is disabled (recorded, required)' },
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
    const id = args.id ? bareFloorId(args.id.trim()) : '';
    if (!id) {
      writeError('coverage disable requires --id <category-id>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (!args.reason) {
      writeError(
        'coverage disable requires --reason <why> — a disable is recorded, never silent (ac-4)',
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const effective = await loadEffectiveTaxonomy(repoRoot);
      if (!taxonomyUniverse(effective).has(id)) {
        writeError(
          `coverage disable: '${id}' is not a known category (floor or project-added) — nothing to disable (check the id with 'coverage list')`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const result = await applyTaxonomyMutation(repoRoot, {
        kind: 'disable',
        id,
        reason: args.reason,
      });
      if (format === 'json') {
        writeJson({ disabled: id, reason: args.reason, path: result.path });
      } else {
        writeHuman(`coverage taxonomy: disabled '${id}'`);
        writeHuman(`  reason: ${args.reason}`);
        writeHuman(`  → ${result.path}`);
      }
    } catch (err) {
      writeError(`coverage disable failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto coverage reroute` — change a category's disposition route via
 * `applyTaxonomyMutation` (ac-2). REQUIRES `--disposition`. The target must be a
 * known category (floor ∪ project-added); a typo'd id is rejected (sweep #4).
 */
const coverageTaxonomyRerouteCommand = defineCommand({
  meta: {
    name: 'reroute',
    description: 'Change a far-field category disposition route in the tier-② override (ac-2)',
  },
  args: {
    id: { type: 'string', description: 'Category id to re-route' },
    disposition: {
      type: 'string',
      description: 'New route: code-verify|user-intent|runtime-post-impl',
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
    const id = args.id ? bareFloorId(args.id.trim()) : '';
    if (!id) {
      writeError('coverage reroute requires --id <category-id>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const disposition = parseDispositionArg(args.disposition);
    if (disposition === undefined) {
      writeError(
        'coverage reroute requires --disposition <code-verify|user-intent|runtime-post-impl>',
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (disposition === null) {
      writeError(
        `invalid --disposition "${args.disposition}"; expected one of: code-verify, user-intent, runtime-post-impl`,
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const effective = await loadEffectiveTaxonomy(repoRoot);
      if (!taxonomyUniverse(effective).has(id)) {
        writeError(
          `coverage reroute: '${id}' is not a known category (floor or project-added) — nothing to re-route (check the id with 'coverage list')`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const result = await applyTaxonomyMutation(repoRoot, { kind: 'reroute', id, disposition });
      if (format === 'json') {
        writeJson({ rerouted: id, disposition, path: result.path });
      } else {
        writeHuman(`coverage taxonomy: rerouted '${id}' → ${disposition}`);
        writeHuman(`  → ${result.path}`);
      }
    } catch (err) {
      writeError(`coverage reroute failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/** Read host-produced candidate proposals from a file or piped stdin (ac-5). */
async function readDiscoveryInput(file: string | undefined): Promise<string> {
  if (file) {
    const f = Bun.file(file);
    if (!(await f.exists())) throw new Error(`candidate file not found: ${file}`);
    return f.text();
  }
  // No --file: the agent piped its proposals on stdin. Refuse an interactive TTY so
  // the command never hangs waiting for input the caller did not provide.
  if (process.stdin.isTTY) {
    throw new Error(
      'coverage discover requires --file <candidates.json> or candidates piped on stdin',
    );
  }
  return Bun.stdin.text();
}

/**
 * Parse + shape-validate the candidate proposals. Accepts either a bare array or a
 * `{ candidates: [...] }` envelope. Each candidate must carry a non-empty string
 * id, lens, and evidence — the CLI never invents these (the discovery agent
 * produced them); it only shapes them before the deterministic gate. Throws on
 * malformed input so the caller renders a usage error (the gate never sees garbage).
 */
function parseDiscoveryCandidates(text: string): DiscoveryCandidate[] {
  const raw = JSON.parse(text);
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.candidates) ? raw.candidates : null;
  if (!list) throw new Error('expected a JSON array of candidates or { "candidates": [...] }');
  return list.map((c: unknown, i: number) => {
    if (typeof c !== 'object' || c === null) throw new Error(`candidate[${i}] must be an object`);
    const { id, lens, evidence } = c as Record<string, unknown>;
    if (typeof id !== 'string' || id.trim().length === 0)
      throw new Error(`candidate[${i}] needs a non-empty string 'id'`);
    if (typeof lens !== 'string' || lens.trim().length === 0)
      throw new Error(`candidate[${i}] needs a non-empty string 'lens'`);
    if (typeof evidence !== 'string' || evidence.trim().length === 0)
      throw new Error(`candidate[${i}] needs a non-empty string 'evidence'`);
    return { id, lens, evidence };
  });
}

/**
 * `ditto coverage discover` — CONSUME host-produced candidate category proposals
 * (from `--file` or stdin — the codebase-scan reasoning is the discovery agent's
 * job, NOT the CLI's, per ADR-0001) and run them through the deterministic gate
 * `admitDiscoveredCategories` against the effective taxonomy (ac-5/ac-6): surface
 * only the grounded, gap-only admits, and the dropped ones WITH their machine
 * reason (no_evidence / reconfirms_covered) for audit — no floor re-confirmation
 * noise. PROPOSE-ONLY by default (mutates nothing, ac-7); pass `--confirm` to route
 * each admitted candidate through the same `applyTaxonomyMutation` add path (ac-2).
 */
const coverageTaxonomyDiscoverCommand = defineCommand({
  meta: {
    name: 'discover',
    description:
      'Gate host-produced candidate far-field categories (grounded + gap-only) and, with --confirm, add the admits (ac-5/ac-6/ac-7)',
  },
  args: {
    file: {
      type: 'string',
      description: 'Path to candidate proposals JSON (omit to read piped stdin)',
      required: false,
    },
    confirm: {
      type: 'boolean',
      description: 'Add the admitted candidates (default off: propose-only, mutates nothing, ac-7)',
      default: false,
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
    let candidates: DiscoveryCandidate[];
    try {
      candidates = parseDiscoveryCandidates(await readDiscoveryInput(args.file));
    } catch (err) {
      writeError(
        `coverage discover input invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const effective = await loadEffectiveTaxonomy(repoRoot);
      const verdicts = admitDiscoveredCategories(candidates, effective);
      const admitted = verdicts
        .filter((v) => v.admitted)
        .map((v) => ({ id: v.id, lens: v.lens ?? '', evidence: v.evidence ?? '' }));
      const dropped = verdicts
        .filter((v) => !v.admitted)
        .map((v) => ({ id: v.id, reason: v.reason, detail: v.detail }));

      // ac-7: proposing is the default and mutates NOTHING. Only an explicit
      // --confirm routes each admitted candidate through the ac-2 add path.
      const added: string[] = [];
      if (args.confirm) {
        for (const a of admitted) {
          const id = bareFloorId(a.id);
          await applyTaxonomyMutation(repoRoot, { kind: 'add', id, lens: a.lens });
          added.push(id);
        }
      }

      if (format === 'json') {
        writeJson({ admitted, dropped, confirmed: Boolean(args.confirm), added });
        return;
      }
      writeHuman(
        `coverage discover: ${admitted.length} admitted, ${dropped.length} dropped${args.confirm ? ` (${added.length} added)` : ' (propose-only — nothing written)'}`,
      );
      for (const a of admitted) {
        writeHuman(`  [admit] ${a.id}`);
        writeHuman(`    ${a.lens}`);
        writeHuman(`    evidence: ${a.evidence}`);
      }
      for (const d of dropped) writeHuman(`  [drop:${d.reason}] ${d.id} — ${d.detail}`);
    } catch (err) {
      writeError(`coverage discover failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const coverageCommand = defineCommand({
  meta: {
    name: 'coverage',
    description:
      'Coverage outcome loop + far-field taxonomy management: record escapes (feedback) / residual rows (residual), surface augmentation candidates (propose), suggest feedback templates (suggest); and manage the tier-② taxonomy — list, add, disable, reroute, discover (wi_260707phi)',
  },
  subCommands: {
    feedback: coverageFeedbackCommand,
    residual: coverageResidualCommand,
    propose: coverageProposeCommand,
    suggest: coverageSuggestCommand,
    list: coverageTaxonomyListCommand,
    add: coverageTaxonomyAddCommand,
    disable: coverageTaxonomyDisableCommand,
    reroute: coverageTaxonomyRerouteCommand,
    discover: coverageTaxonomyDiscoverCommand,
  },
});
