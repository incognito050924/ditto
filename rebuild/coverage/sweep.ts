import {
  CLOSED_STATES,
  type CategoryRelevanceVerdict,
  type CoverageMap,
  type CoverageNode,
  type CoverageNodeState,
} from './schemas';
import {
  CATEGORY_NODE_PREFIX,
  FAR_FIELD_TAXONOMY_FLOOR,
  type FarFieldCategory,
} from './taxonomy';

/** A closing (non-open) state — the three states a category can be settled into. */
type ClosedState = Exclude<CoverageNodeState, 'open'>;

/** Default dry threshold K: K consecutive rounds with no admissible novelty ⇒ depth-dry. */
export const DEFAULT_DRY_K = 2;

function isClosed(node: CoverageNode): boolean {
  return CLOSED_STATES.has(node.state);
}

/** A category node is one seeded from a taxonomy category (id prefix). */
function isCategoryNode(node: CoverageNode): boolean {
  return node.id.startsWith(CATEGORY_NODE_PREFIX);
}

/**
 * Seed the coverage nodes for category-complete discovery (ADR-0023 decision 1):
 * the root (original intent) plus one node per taxonomy category. Because every
 * category is a real node, termination now requires each to be swept and closed
 * — novelty-dry alone can no longer terminate, and an un-swept category cannot
 * pass silently. The node set IS the per-category sweep ledger; no separate
 * bookkeeping.
 *
 * The binary relevance gate (ADR-20260625) runs at seed: a category is pre-closed
 * ONLY by a well-formed not-relevant verdict (`relevant:false` ∧ `reason` ∧
 * `residual_risk`) — the conservative default keeps every other category OPEN
 * (relevant → fully in scope). A skip lands as an `out_of_scope` node carrying
 * `close_reason` + `residual_risk`, so it is an auditable, recorded decision,
 * never a silent drop.
 */
export function farFieldCoverageNodes(
  intent: string,
  rootId = 'cov-root',
  taxonomy: readonly FarFieldCategory[] = FAR_FIELD_TAXONOMY_FLOOR,
  verdicts: readonly CategoryRelevanceVerdict[] = [],
): CoverageNode[] {
  const skips = new Map(
    verdicts
      .filter(
        (v) =>
          v.relevant === false &&
          v.reason !== undefined &&
          v.residual_risk !== undefined,
      )
      .map((v) => [v.id, v]),
  );
  const categoryIds = taxonomy.map((c) => `${CATEGORY_NODE_PREFIX}${c.id}`);
  const root: CoverageNode = {
    id: rootId,
    parent_id: null,
    label: intent,
    state: 'open',
    children: categoryIds,
  };
  const categories: CoverageNode[] = taxonomy.map((c, i) => {
    const id = categoryIds[i] as string;
    const skip = skips.get(c.id);
    if (skip !== undefined) {
      return {
        id,
        parent_id: rootId,
        label: c.lens,
        state: 'out_of_scope',
        children: [],
        close_reason: skip.reason as string,
        residual_risk: skip.residual_risk as string,
      };
    }
    return {
      id,
      parent_id: rootId,
      label: c.lens,
      state: 'open',
      children: [],
    };
  });
  return [root, ...categories];
}

export interface SeedOptions {
  taxonomy?: readonly FarFieldCategory[];
  verdicts?: readonly CategoryRelevanceVerdict[];
  rootId?: string;
}

/** Build a fresh {@link CoverageMap} from the seeded nodes (root + categories). */
export function seedCoverageMap(intent: string, opts: SeedOptions = {}): CoverageMap {
  const rootId = opts.rootId ?? 'cov-root';
  return {
    root_id: rootId,
    nodes: farFieldCoverageNodes(intent, rootId, opts.taxonomy, opts.verdicts),
  };
}

export interface CloseJustification {
  reason?: string;
  residual_risk?: string;
}

export interface CloseGateResult {
  decision: 'pass' | 'block';
  reasons: string[];
}

/**
 * Justification-close gate (ADR-0023 decision 2, fail-closed). Closing a CATEGORY
 * node in a non-resolved state (out_of_scope / user_owned) is a skip/deferral: it
 * MUST carry both a `reason` (WHY skipped → close_reason) and a `residual_risk`
 * (WHAT survives the skip), or the close is refused. A `resolved` close swept the
 * scope, so the sweep itself is the record — no justification needed. Non-category
 * nodes are not gated here (the gate targets the category breadth ledger). Pure.
 */
export function justifiedCloseGate(
  node: CoverageNode,
  state: ClosedState,
  justification: CloseJustification,
): CloseGateResult {
  const reasons: string[] = [];
  if (isCategoryNode(node) && state !== 'resolved') {
    if (justification.reason === undefined || justification.reason.trim() === '') {
      reasons.push(
        `category ${node.id} skipped as ${state} without a reason: a category skip must be a recorded, justified decision`,
      );
    }
    if (
      justification.residual_risk === undefined ||
      justification.residual_risk.trim() === ''
    ) {
      reasons.push(
        `category ${node.id} skipped as ${state} without a residual_risk: a skip must name the surviving risk it leaves behind`,
      );
    }
  }
  return { decision: reasons.length === 0 ? 'pass' : 'block', reasons };
}

/** Raised when the justification-close gate refuses a skip (fail-closed, loud). */
export class UnjustifiedCloseError extends Error {
  public readonly reasons: string[];

  constructor(id: string, reasons: string[]) {
    super(`justification-close gate refused closing ${id}: ${reasons.join('; ')}`);
    this.name = 'UnjustifiedCloseError';
    this.reasons = reasons;
  }
}

/**
 * Close a coverage node by flipping its state, fail-closed through the
 * justification gate. Returns a fresh map (never mutates input); throws
 * {@link UnjustifiedCloseError} when a non-resolved category skip lacks its
 * reason/residual_risk. A resolved close carries no justification.
 */
export function closeCoverageNode(
  map: CoverageMap,
  id: string,
  state: ClosedState,
  justification: CloseJustification = {},
): CoverageMap {
  const target = map.nodes.find((n) => n.id === id);
  if (target === undefined) {
    throw new Error(`unknown coverage node id: ${id}`);
  }
  const gate = justifiedCloseGate(target, state, justification);
  if (gate.decision === 'block') {
    throw new UnjustifiedCloseError(id, gate.reasons);
  }
  const recordJustification = state !== 'resolved';
  return {
    ...map,
    nodes: map.nodes.map((n) =>
      n.id === id
        ? {
            ...n,
            state,
            ...(recordJustification && justification.reason !== undefined
              ? { close_reason: justification.reason }
              : {}),
            ...(recordJustification && justification.residual_risk !== undefined
              ? { residual_risk: justification.residual_risk }
              : {}),
          }
        : n,
    ),
  };
}

/**
 * Mechanical dry-counter step (novelty/depth axis): an admissible new branch
 * resets the counter to 0; a round that added none increments it. Admissible
 * findings are finite, so this is a monotone-decreasing measure — termination is
 * guaranteed (수렴).
 */
export function recordDryRound(
  counter: number,
  round: { admissibleBranchesAdded: number },
): number {
  return round.admissibleBranchesAdded > 0 ? 0 : counter + 1;
}

/**
 * Termination (ADR-0023) — breadth AND depth, BOTH required:
 *  - breadth: every node in the map is closed. Because the categories are
 *    seeded nodes, this now means each category was swept-and-closed (resolved)
 *    OR justified-closed (out_of_scope / user_owned). An un-swept category keeps
 *    the sweep open — novelty-dry alone can no longer terminate.
 *  - depth: the dry counter has reached K (K consecutive rounds with no
 *    admissible new branch).
 */
export function isCoverageTerminated(
  map: CoverageMap,
  dryCounter: number,
  k: number = DEFAULT_DRY_K,
): boolean {
  const allClosed = map.nodes.every(isClosed);
  return allClosed && dryCounter >= k;
}

/** One skipped/deferred category with its recorded justification (never silent). */
export interface FarFieldSkip {
  id: string;
  state: 'out_of_scope' | 'user_owned';
  reason: string | null;
  residual_risk: string | null;
}

/** Deterministic breadth-coverage summary of one sweep. */
export interface FarFieldCoverageReport {
  /** Far-field category nodes seeded (cov-cat-*). */
  seeded: number;
  /** Categories swept and settled (resolved). */
  resolved: number;
  /** Categories still open (not yet swept). */
  open: number;
  /** Categories skipped/deferred, each with its recorded justification. */
  skipped: FarFieldSkip[];
  /** Breadth complete — ≥1 category seeded AND no node still open. */
  complete: boolean;
}

/**
 * Deterministic breadth audit (pure over the map): how the far-field breadth was
 * handled — how many categories were swept (resolved), skipped (with the
 * justification the close gate forced), or are still open, and whether the
 * breadth is complete. `complete` agrees with the breadth axis of
 * {@link isCoverageTerminated} (no node open), so a closed-category report can
 * never read complete while some derived scope is still open.
 */
export function farFieldCoverageReport(map: CoverageMap): FarFieldCoverageReport {
  const cats = map.nodes.filter((n) => n.id.startsWith(CATEGORY_NODE_PREFIX));
  const skipped: FarFieldSkip[] = cats
    .filter((n) => n.state === 'out_of_scope' || n.state === 'user_owned')
    .map((n) => ({
      id: n.id,
      state: n.state as 'out_of_scope' | 'user_owned',
      reason: n.close_reason ?? null,
      residual_risk: n.residual_risk ?? null,
    }));
  return {
    seeded: cats.length,
    resolved: cats.filter((n) => n.state === 'resolved').length,
    open: cats.filter((n) => n.state === 'open').length,
    skipped,
    complete: cats.length > 0 && map.nodes.every((n) => n.state !== 'open'),
  };
}
