/**
 * ac-11b outcome loop — coverage-escape feedback.
 *
 * Two pieces, both deterministic and code-only (NO automatic LLM classification,
 * NO aggregation/threshold engine — out of scope):
 *
 *   1. `CoverageFeedbackLedger` — an append-only jsonl ledger under
 *      `.ditto/local`. Unlike `CoverageStore` (per-work-item replace-json), this
 *      ledger crosses work item boundaries so the SAME category re-appearing in a
 *      later work item can be counted (ac-4 recurrence). `recordCoverageRound` /
 *      CoverageStore are per-wi; this is the cross-wi tail.
 *
 *   2. `attributeCoverageEscape` — a structural attribution GUARD (ac-2). Given a
 *      manual escape report (work_item_id + category_id + evidence) it reads the
 *      SAME `coverage.json` the far-field verdict reads (`CoverageStore.getMap`)
 *      and decides depth / breadth / reject from that one input — so the gate
 *      (accept?) and the score (fault_kind) start from the same state, never a
 *      re-judgement. Attribution is structural, not semantic.
 */

import {
  type CoverageFaultKind,
  type CoverageFeedback,
  type CoverageFeedbackEntry,
  coverageFeedbackEntry,
} from '~/schemas/coverage';
import type { CoverageMap, CoverageNode } from '~/schemas/coverage';
import type { CoverageStore } from './coverage-store';
import {
  CATEGORY_NODE_PREFIX,
  FAR_FIELD_TAXONOMY_FLOOR,
  type FarFieldCategory,
} from './coverage-taxonomy';
import { localDir } from './ditto-paths';
import { atomicWriteText } from './fs';

/**
 * Append-only jsonl ledger of coverage-escape rows (ac-11b). One file for the
 * whole repo (`.ditto/local/coverage-feedback.jsonl`) — crossing work item
 * boundaries is the point (ac-4 recurrence). Mirrors EvidenceStore's commands
 * jsonl: read-existing + append-one + atomic full rewrite (acceptable for v0;
 * concurrent writers deferred).
 */
export class CoverageFeedbackLedger {
  constructor(public readonly repoRoot: string) {}

  private path(): string {
    return localDir(this.repoRoot, 'coverage-feedback.jsonl');
  }

  /**
   * Append one feedback row. `recorded_at` is INJECTED by the caller (not read
   * from the clock here) so the ledger stays deterministic and testable, and so
   * a sandbox that blocks `Date.now()`/`new Date()` cannot break recording. The
   * row is schema-validated (coverageFeedbackEntry) before it is written.
   */
  async append(
    row: Omit<CoverageFeedbackEntry, 'recorded_at'>,
    recordedAt: string,
  ): Promise<CoverageFeedbackEntry> {
    const entry = coverageFeedbackEntry.parse({ ...row, recorded_at: recordedAt });
    const path = this.path();
    const file = Bun.file(path);
    const existing = (await file.exists()) ? await file.text() : '';
    const trimmed = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
    await atomicWriteText(path, `${trimmed}${JSON.stringify(entry)}\n`);
    return entry;
  }

  /**
   * Read every row. A line that fails schema parse throws with file:line context
   * (fail-closed — a corrupt ledger is a real problem, not a silent skip).
   */
  async readAll(): Promise<CoverageFeedbackEntry[]> {
    const path = this.path();
    const file = Bun.file(path);
    if (!(await file.exists())) return [];
    const text = await file.text();
    const lines = text.split('\n').filter((l) => l.length > 0);
    return lines.map((line, idx) => {
      try {
        return coverageFeedbackEntry.parse(JSON.parse(line));
      } catch (err) {
        throw new Error(`coverage-feedback.jsonl ${path}:${idx + 1} invalid: ${String(err)}`);
      }
    });
  }
}

/**
 * Count how many ledger rows each `category_id` has (ac-4 recurrence base). Pure
 * over the rows — the threshold/aggregation engine that would act on a high count
 * is out of scope for this slice.
 */
export function recurrenceCounts(entries: readonly CoverageFeedbackEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.category_id, (counts.get(e.category_id) ?? 0) + 1);
  return counts;
}

/** Outcome of the structural attribution guard (ac-2). */
export interface CoverageAttribution {
  accepted: boolean;
  /** Set only when accepted — the SAME coverage.json state drives this. */
  fault_kind?: CoverageFaultKind;
  /** Set only when rejected — why the escape is not a coverage fault. */
  reason?: string;
}

/** Strip an optional `cov-cat-` prefix so a category_id matches a floor id. */
function bareFloorId(categoryId: string): string {
  return categoryId.startsWith(CATEGORY_NODE_PREFIX)
    ? categoryId.slice(CATEGORY_NODE_PREFIX.length)
    : categoryId;
}

/** Find the coverage node a category_id refers to (by bare id or cov-cat- form). */
function findCoverageNode(map: CoverageMap, categoryId: string): CoverageNode | undefined {
  const prefixed = categoryId.startsWith(CATEGORY_NODE_PREFIX)
    ? categoryId
    : `${CATEGORY_NODE_PREFIX}${categoryId}`;
  return map.nodes.find((n) => n.id === categoryId || n.id === prefixed);
}

/**
 * Structural attribution guard (ac-2). Reads the work item's coverage.json (the
 * same map the far-field verdict reads) and decides:
 *
 *   - floor category whose node is `resolved` (dry-closed — judged safe yet broke)
 *       → accept as `depth` (under-probed; an existing lens that should have caught it)
 *   - category absent from BOTH the floor taxonomy AND the coverage map
 *       → accept as `breadth` (a missing lens — the floor never seeded this domain)
 *   - anything else (still-open floor node, a non-floor node handled normally, a
 *     general bug that maps to no floor lens but IS in coverage) → reject, no ledger row
 *
 * The accept-decision and the fault_kind are both derived from this one map +
 * floor pair, so gate and score never diverge.
 */
export async function attributeCoverageEscape(
  store: CoverageStore,
  input: CoverageFeedback,
  floor: readonly FarFieldCategory[] = FAR_FIELD_TAXONOMY_FLOOR,
): Promise<CoverageAttribution> {
  const map = (await store.exists(input.work_item_id))
    ? await store.getMap(input.work_item_id)
    : null;

  const bare = bareFloorId(input.category_id);
  const isFloorCategory = floor.some((c) => c.id === bare);
  const node = map ? findCoverageNode(map, input.category_id) : undefined;

  if (isFloorCategory) {
    if (node?.state === 'resolved') {
      return { accepted: true, fault_kind: 'depth' };
    }
    return {
      accepted: false,
      reason: node
        ? `floor category '${bare}' is '${node.state}', not a dry-closed (resolved) escape`
        : `floor category '${bare}' is not seeded in this work item's coverage map`,
    };
  }

  // Not a floor category.
  if (!node) {
    return { accepted: true, fault_kind: 'breadth' };
  }
  return {
    accepted: false,
    reason: `category '${input.category_id}' is a non-floor coverage node (state '${node.state}') — a general bug, not a floor escape`,
  };
}
