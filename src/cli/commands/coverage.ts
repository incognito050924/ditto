import { defineCommand } from 'citty';
import { CoverageFeedbackLedger, recurrenceCounts } from '~/core/coverage-feedback';
import { attributeCoverageEscape, suggestCoverageFeedback } from '~/core/coverage-feedback';
import { CoverageStore } from '~/core/coverage-store';
import { CATEGORY_NODE_PREFIX, FAR_FIELD_TAXONOMY_FLOOR } from '~/core/coverage-taxonomy';
import { resolveRepoRootForCreate } from '~/core/fs';
import { coverageFeedback } from '~/schemas/coverage';
import type { CoverageFeedbackEntry } from '~/schemas/coverage';
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
      const entries = args.wi ? all.filter((e) => e.work_item_id === args.wi) : all;
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

export const coverageCommand = defineCommand({
  meta: {
    name: 'coverage',
    description:
      'Coverage outcome loop (ac-11b): record escapes (feedback), surface taxonomy-augmentation candidates (propose), and suggest feedback templates for a verify miss (suggest)',
  },
  subCommands: {
    feedback: coverageFeedbackCommand,
    propose: coverageProposeCommand,
    suggest: coverageSuggestCommand,
  },
});
