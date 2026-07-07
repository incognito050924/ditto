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
  isFarFieldEscape,
} from '~/schemas/coverage';
import type { CoverageMap, CoverageNode } from '~/schemas/coverage';
import type { CoverageStore } from './coverage-store';
import {
  CATEGORY_NODE_PREFIX,
  FAR_FIELD_ROUTED_OUT,
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

/** One copy-paste `ditto coverage feedback` template the suggest command surfaces. */
export interface CoverageSuggestion {
  /** Bare floor category id (no cov-cat- prefix) the escape would be attributed to. */
  category_id: string;
  /** depth = a dry-closed (resolved) category that was judged safe yet may have broken. */
  fault_kind: CoverageFaultKind;
  /** The category's coverage-node label (its probing-question lens), for context. */
  lens: string;
  /** A copy-paste `ditto coverage feedback ...` command line the user can run. */
  template: string;
}

/**
 * Build copy-paste `ditto coverage feedback` SUGGESTIONS for a work item's
 * coverage map (ac-3, wi_260622kb4). This is PURE and SUGGEST-ONLY: it reads the
 * map, picks the categories whose escape `attributeCoverageEscape` would ACCEPT
 * — currently the dry-closed (resolved) floor categories (`depth`) — and emits one
 * feedback template per candidate. It records NOTHING and mutates NO ledger; the
 * user decides whether to run the template. The evidence is left as a placeholder
 * the user fills with the triggering failure (the command never invents it).
 *
 * Only the structural attribution guard's accepted shape is mirrored here so the
 * suggestion and the eventual `feedback` accept never diverge (gate ↔ score): a
 * resolved floor category → depth. Still-open / skipped categories are not
 * dry-closed escapes, so they are omitted (the guard would reject them).
 */
export function suggestCoverageFeedback(
  map: CoverageMap,
  workItemId: string,
  floor: readonly FarFieldCategory[] = FAR_FIELD_TAXONOMY_FLOOR,
): CoverageSuggestion[] {
  const floorIds = new Set(floor.map((c) => c.id));
  const suggestions: CoverageSuggestion[] = [];
  for (const node of map.nodes) {
    if (!node.id.startsWith(CATEGORY_NODE_PREFIX)) continue;
    if (node.state !== 'resolved') continue;
    const bare = node.id.slice(CATEGORY_NODE_PREFIX.length);
    if (!floorIds.has(bare)) continue;
    suggestions.push({
      category_id: bare,
      fault_kind: 'depth',
      lens: node.label,
      template: `ditto coverage feedback --wi ${workItemId} --category ${bare} --evidence "<what slipped past the resolved sweep>"`,
    });
  }
  return suggestions;
}

/**
 * Count how many FAR-FIELD ESCAPE rows each `category_id` has (ac-4 recurrence
 * base). This is the far-field cost/escape aggregation: it counts ONLY depth and
 * breadth escapes and EXCLUDES `residual` rows (general followup / residual-risk),
 * so the new kind is recorded in the ledger but invisible to far-field cost stats
 * (ac-3, wi_26062257r). Pure over the rows — the threshold/aggregation engine that
 * would act on a high count is out of scope for this slice.
 */
export function recurrenceCounts(entries: readonly CoverageFeedbackEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (!isFarFieldEscape(e.fault_kind)) continue;
    counts.set(e.category_id, (counts.get(e.category_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Record a general followup / residual-risk row (ac-3, wi_26062257r) — NOT a
 * far-field escape. This bypasses the far-field structural guard
 * (`attributeCoverageEscape`) on purpose: a residual row is not a floor escape, so
 * it has no depth/breadth attribution. It is appended to the SAME ledger with
 * `fault_kind: 'residual'` so it is kept and visible to `propose`/`readAll`, yet
 * `recurrenceCounts` (the far-field cost aggregation) excludes it. `recorded_at`
 * is injected by the caller for determinism, as with `append`.
 */
export async function recordResidual(
  ledger: CoverageFeedbackLedger,
  input: CoverageFeedback,
  recordedAt: string,
): Promise<CoverageFeedbackEntry> {
  return ledger.append(
    {
      work_item_id: input.work_item_id,
      category_id: input.category_id,
      fault_kind: 'residual',
      evidence: input.evidence,
    },
    recordedAt,
  );
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
 *   - category routed OUT of the floor (FAR_FIELD_ROUTED_OUT ledger)
 *       → reject with the routing rationale: a receiving-gate escape, never `breadth`
 *         (wi_260707rwf ac-3)
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

  // Not a floor category — but a ROUTED-OUT one is not a missing lens either
  // (wi_260707rwf ac-3): the category left the floor deliberately, with a ledger
  // record naming its receiving gate. Its escape is a RECEIVING-GATE escape (that
  // gate was not consumed), never a breadth fault — accepting it as breadth would
  // propose re-adding a lens the routing decision removed.
  const routedOut = FAR_FIELD_ROUTED_OUT.find((r) => r.id === bare);
  if (routedOut) {
    return {
      accepted: false,
      reason: `category '${bare}' was routed out of the far-field floor to '${routedOut.route}' (${routedOut.reason}) — this escape is a receiving-gate escape of '${routedOut.route}', not a missing floor lens (no breadth fault)`,
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
