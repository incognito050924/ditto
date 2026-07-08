import type { z } from 'zod';
import {
  NoOpponentAvailableError,
  type OpponentAvailability,
  type OpponentCandidate,
  type OpponentSelection,
  resolveOpponentCandidates,
  selectOpponent,
} from '~/core/opponent-router';
import type { dialecticInput } from '~/schemas/dialectic';
import type { PrismIssueMap, PrismNodeEvaluation } from '~/schemas/prism';
import { deriveFragmentMappings, severityOf } from './engine';
import type { FragmentMapping, IntentFragment } from './engine';

/**
 * Model-assist opponent CONSUMPTION seam (wi_260708tzs, node tzs-opponent).
 *
 * The symmetric partner to the deterministic divergence guard (engine.ts): where
 * that shell flags meaningless-divergence WITHOUT any model call, this seam adds the
 * MODEL half of the two prism concerns — but only on the nodes the deterministic
 * A-shell already flagged (cost localization), never a blanket sweep.
 *
 *   - ac-5  devil's-advocate critique: for an A2-flagged critical node (its prism
 *           evaluation is `unevaluated` — a critical resolved-close rejected for
 *           lacking justification) drive the dialectic-opponent (via opponent-router)
 *           to produce a critique + Popper refutation, recorded to opponent_critique.
 *   - ac-6  independent 2nd perspective: at the anchor re-facing point drive the Codex
 *           opponent (the same asset far-field uses to refute) to re-derive an
 *           independent judgment from the ORIGINAL intent, recorded to opponent_dissent.
 *
 * ADR-0001 boundary — this module NEVER spawns a provider or shells out. opponent-router
 * only RESOLVES which opponent to use (pure policy). The actual invocation is
 * host-delegated (the thin layer the skill/CLI drives), surfaced here as the
 * {@link OpponentDelegate} callback; this module only CONSUMES the structured output it
 * returns, mirroring coverage-relevance.ts exactly.
 *
 * ADR-0018 graceful degrade (OBJ-3) — when NO opponent host is available (opponent-router
 * yields no candidate / selection blocked) the seam does NOT crash, hang, or fake a pass:
 * it degrades to the deterministic shell ONLY and STAMPS opponent_status = `host_absent`.
 * The degrade is SELF-DESCRIBING, never silent, mirroring coverage.ts `tool_absent`.
 *
 * Pure by design (like engine.ts): it computes over an in-memory map and returns a new
 * one. The single async is the host-delegated {@link OpponentDelegate}; the Run-tier
 * persistence (single writeMap — OBJ-2 single-writer) is the driver's job (loop.ts).
 */

type ModelPolicy = z.infer<typeof dialecticInput>['model_policy'];

/** The two hosts a prism session can run on (opponent-router's `currentHost`). */
export type DialecticHost = 'claude-code' | 'codex';

/** The concern the resolved opponent is driven for — routes the record-back field. */
export type OpponentConcern = 'critique' | 'dissent' | 'semantic';

/**
 * The brief handed to the host-delegated invocation. The thin host layer runs the
 * RESOLVED opponent in an isolated context (ADR-0001) against this brief and returns
 * its structured output. `intent` is the ORIGINAL intent text (ac-6 re-derives an
 * independent perspective from it; ac-5 critiques against it).
 */
export interface OpponentBrief {
  concern: OpponentConcern;
  node_id: string;
  label: string;
  intent: string;
  /** A1 semantic critic only: the covered intent fragment this (fragment,node) pair maps. */
  fragment?: { id: string; text: string };
  selection: OpponentSelection;
}

/**
 * Host-delegated invocation (ADR-0001). Returns the opponent's structured critique/
 * dissent text, or `null`/empty when the resolved host could not produce one — which
 * the seam records as a self-describing `host_absent` degrade (never a fake pass).
 * The seam NEVER constructs or spawns this itself; the CLI/skill wires it.
 */
export type OpponentDelegate = (brief: OpponentBrief) => Promise<string | null>;

/**
 * Per-run opponent-invocation ceiling (Note B). Many A2-flagged nodes must not balloon
 * the developer's token cost, so only the first N flagged nodes are invoked per run;
 * the rest are left for a later run (reported via {@link OpponentSeamOutcome.skipped_by_cap}).
 */
export const OPPONENT_FANOUT_CAP = 3;

export interface OpponentSeamConfig {
  policy: ModelPolicy;
  currentHost: DialecticHost;
  /** Host-availability predicate the driver supplies (e.g. is the codex CLI present). */
  isAvailable: (candidate: OpponentCandidate) => OpponentAvailability;
  delegate: OpponentDelegate;
  /** ORIGINAL intent text (ac-6 anchor re-facing re-derives from it). */
  intent: string;
  /** Per-run invocation ceiling (Note B); defaults to {@link OPPONENT_FANOUT_CAP}. */
  cap?: number;
  /** ac-6 only: the anchor node the dissent is recorded on; defaults to the tree root. */
  anchorNodeId?: string;
}

export interface OpponentSeamOutcome {
  /** The map with the record-back applied — the driver persists it in ONE writeMap. */
  prism: PrismIssueMap;
  /** Did opponent-router resolve a usable opponent this run (false → shell-only degrade). */
  host_available: boolean;
  /** The resolved opponent, or null when no host was available. */
  selection: OpponentSelection | null;
  /** Node ids stamped `engaged` (critique/dissent recorded). */
  engaged: string[];
  /** Node ids stamped `host_absent` (self-describing degrade). */
  degraded: string[];
  /** Flagged nodes NOT invoked this run because of the per-run ceiling (Note B). */
  skipped_by_cap: number;
}

/** Per-node outcome the record-back consumes — engaged (with text) or host_absent. */
export type OpponentOutcome = { status: 'engaged'; text: string } | { status: 'host_absent' };

// ── pure policy resolution + selectors ───────────────────────────────────────

/**
 * Resolve the opponent for this run via opponent-router (pure policy). Returns the
 * selection, or `null` when no candidate is available / selection is blocked — the
 * `null` is the ADR-0018 degrade signal the caller stamps as `host_absent`. Any other
 * error propagates (a genuine bug, not a missing host).
 */
export function resolveOpponentSelection(config: OpponentSeamConfig): OpponentSelection | null {
  const candidates = resolveOpponentCandidates(config.policy, { currentHost: config.currentHost });
  try {
    return selectOpponent(candidates, config.isAvailable);
  } catch (error) {
    if (error instanceof NoOpponentAvailableError) return null;
    throw error;
  }
}

/**
 * The A2-flagged critical nodes: a node whose prism evaluation is `unevaluated` (a
 * critical resolved-close the A2 shell rejected for lacking justification) AND whose
 * severity is critical. This is the cost-localizing trigger for ac-5 — the seam fires
 * ONLY here, never a blanket sweep.
 */
export function flaggedCriticalNodeIds(prism: PrismIssueMap): string[] {
  return prism.evaluations
    .filter((e) => e.evaluation === 'unevaluated')
    .map((e) => e.node_id)
    .filter((id) => severityOf(prism, id) === 'critical');
}

function labelOf(prism: PrismIssueMap, nodeId: string): string {
  return prism.tree.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
}

/**
 * Order-preserving upsert of one node's evaluation patch. Pure; the ONLY writer of the
 * evaluations array in this seam, so the record-back stays deterministic and additive.
 */
function upsertEvaluation(
  prism: PrismIssueMap,
  nodeId: string,
  patch: Partial<PrismNodeEvaluation>,
): PrismIssueMap {
  const exists = prism.evaluations.some((e) => e.node_id === nodeId);
  const evaluations = exists
    ? prism.evaluations.map((e) => (e.node_id === nodeId ? { ...e, ...patch } : e))
    : [...prism.evaluations, { node_id: nodeId, ...patch }];
  return { ...prism, evaluations };
}

/** Record an ac-5 critique outcome onto the node's evaluation (Run-tier annotation). */
export function recordOpponentCritique(
  prism: PrismIssueMap,
  nodeId: string,
  outcome: OpponentOutcome,
): PrismIssueMap {
  const patch: Partial<PrismNodeEvaluation> =
    outcome.status === 'engaged'
      ? { opponent_critique: outcome.text, opponent_status: 'engaged' }
      : { opponent_status: 'host_absent' };
  return upsertEvaluation(prism, nodeId, patch);
}

/** Record an ac-6 dissent outcome onto the anchor node's evaluation (Run-tier annotation). */
export function recordOpponentDissent(
  prism: PrismIssueMap,
  nodeId: string,
  outcome: OpponentOutcome,
): PrismIssueMap {
  const patch: Partial<PrismNodeEvaluation> =
    outcome.status === 'engaged'
      ? { opponent_dissent: outcome.text, opponent_status: 'engaged' }
      : { opponent_status: 'host_absent' };
  return upsertEvaluation(prism, nodeId, patch);
}

// ── ac-5 · dialectic-opponent critique over A2-flagged critical nodes ─────────

/**
 * ac-5: drive the dialectic-opponent over every A2-flagged critical node (up to the
 * per-run cap) and record its critique. Host absent → every flagged node degrades to a
 * self-describing `host_absent` stamp with NO invocation. When a host IS available but
 * the delegate returns null/empty for a node, THAT node still degrades (self-describing,
 * never silent). Returns a new map + a measurable summary (OBJ-4 durable trace lives in
 * the returned map's evaluations, which the driver persists in one writeMap).
 */
export async function engageDialecticCritique(
  prism: PrismIssueMap,
  config: OpponentSeamConfig,
): Promise<OpponentSeamOutcome> {
  const flagged = flaggedCriticalNodeIds(prism);
  const selection = resolveOpponentSelection(config);

  if (selection === null) {
    // ADR-0018 / OBJ-3: no host → deterministic shell only, stamp EVERY flagged node
    // host_absent. No invocation, never silent, never a fake pass.
    let next = prism;
    for (const nodeId of flagged) {
      next = recordOpponentCritique(next, nodeId, { status: 'host_absent' });
    }
    return {
      prism: next,
      host_available: false,
      selection: null,
      engaged: [],
      degraded: [...flagged],
      skipped_by_cap: 0,
    };
  }

  const cap = config.cap ?? OPPONENT_FANOUT_CAP;
  let next = prism;
  const engaged: string[] = [];
  const degraded: string[] = [];
  let invoked = 0;
  let skippedByCap = 0;

  for (const nodeId of flagged) {
    if (invoked >= cap) {
      skippedByCap += 1;
      continue;
    }
    invoked += 1;
    // Sequential await (never Promise.all): keeps the fan-out bounded and the map fold
    // single-threaded, so the driver's single writeMap is race-free (OBJ-2).
    const text = await config.delegate({
      concern: 'critique',
      node_id: nodeId,
      label: labelOf(next, nodeId),
      intent: config.intent,
      selection,
    });
    if (text && text.trim().length > 0) {
      next = recordOpponentCritique(next, nodeId, { status: 'engaged', text });
      engaged.push(nodeId);
    } else {
      next = recordOpponentCritique(next, nodeId, { status: 'host_absent' });
      degraded.push(nodeId);
    }
  }

  return {
    prism: next,
    host_available: true,
    selection,
    engaged,
    degraded,
    skipped_by_cap: skippedByCap,
  };
}

// ── ac-6 · Codex independent 2nd-perspective dissent at anchor re-facing ──────

/**
 * ac-6: at the anchor re-facing point drive the Codex opponent to re-derive an
 * INDEPENDENT 2nd perspective from the ORIGINAL intent and record it as dissent
 * (dissent = preserved independent judgment) on the anchor node (defaults to the tree
 * root — the intent frame). Host absent → self-describing `host_absent` stamp, no
 * invocation. Single anchor node, so the cap is naturally 1.
 */
export async function engageIndependentDissent(
  prism: PrismIssueMap,
  config: OpponentSeamConfig,
): Promise<OpponentSeamOutcome> {
  const anchor = config.anchorNodeId ?? prism.tree.root_id;
  const selection = resolveOpponentSelection(config);

  if (selection === null) {
    const next = recordOpponentDissent(prism, anchor, { status: 'host_absent' });
    return {
      prism: next,
      host_available: false,
      selection: null,
      engaged: [],
      degraded: [anchor],
      skipped_by_cap: 0,
    };
  }

  const text = await config.delegate({
    concern: 'dissent',
    node_id: anchor,
    label: labelOf(prism, anchor),
    intent: config.intent,
    selection,
  });
  if (text && text.trim().length > 0) {
    const next = recordOpponentDissent(prism, anchor, { status: 'engaged', text });
    return {
      prism: next,
      host_available: true,
      selection,
      engaged: [anchor],
      degraded: [],
      skipped_by_cap: 0,
    };
  }
  const next = recordOpponentDissent(prism, anchor, { status: 'host_absent' });
  return {
    prism: next,
    host_available: true,
    selection,
    engaged: [],
    degraded: [anchor],
    skipped_by_cap: 0,
  };
}

// ── A1 · semantic critic (achieve-vs-characterize) · advisory, non-blocking ───

/**
 * A1 semantic-critic targets: EXACTLY the covered (fragment,node) pairs the deterministic
 * string-match `deriveFragmentMappings` yields — the cost-localizing trigger. The A1 seam
 * fires ONLY on these pairs (mirroring {@link flaggedCriticalNodeIds}), never a blanket
 * sweep; zero covered mappings → empty list. `fragments` are the caller-injected
 * `buildIntentFragments(intent)` output. This module does NOT touch `deriveFragmentMappings`'
 * substring behavior (out of scope) — it consumes its result verbatim.
 */
export function semanticCriticTargets(
  prism: PrismIssueMap,
  fragments: readonly IntentFragment[],
): FragmentMapping[] {
  return deriveFragmentMappings(fragments, prism);
}

/** Record an A1 achieve-vs-characterize outcome onto the node's SEPARATE advisory field. */
export function recordSemanticCritique(
  prism: PrismIssueMap,
  nodeId: string,
  outcome: OpponentOutcome,
): PrismIssueMap {
  const patch: Partial<PrismNodeEvaluation> =
    outcome.status === 'engaged'
      ? { semantic_critique: outcome.text, semantic_status: 'engaged' }
      : { semantic_status: 'host_absent' };
  return upsertEvaluation(prism, nodeId, patch);
}

/** Per-run outcome the A1 seam returns; the driver persists `prism` in one writeMap. */
export interface SemanticCriticOutcome {
  prism: PrismIssueMap;
  host_available: boolean;
  selection: OpponentSelection | null;
  /** Node ids stamped `engaged` (achieve-vs-characterize text recorded). */
  engaged: string[];
  /** Node ids stamped `host_absent` (self-describing degrade). */
  degraded: string[];
  /** Covered pairs NOT invoked this run because of the per-run ceiling. */
  skipped_by_cap: number;
}

/**
 * A1 semantic critic (achieve-vs-characterize) — ADVISORY, NON-BLOCKING. Drives the host
 * delegate over every covered (fragment,node) pair (up to the per-run cap) to judge whether
 * the node ACHIEVED the fragment or only CHARACTERIZED it, recording the verdict to the
 * SEPARATE `semantic_*` fields (never opponent_*, so per-seam degrade attribution stays
 * clean). It is recorded ONLY — criticalTermination never reads these fields, so the launch/
 * close gate is structurally unchanged (ac-3).
 *
 * ADR-0018 degrade: no host (resolveOpponentSelection null) → every target degrades to a
 * self-describing `host_absent` stamp with NO invocation. Host present but the delegate
 * returns null/empty OR THROWS → THAT pair degrades host_absent (throw is caught per-node so
 * it is symmetric to the null path — no retry, no propagation). Sequential await (never
 * Promise.all) keeps the single writeMap race-free.
 */
export async function engageSemanticCritique(
  prism: PrismIssueMap,
  fragments: readonly IntentFragment[],
  config: OpponentSeamConfig,
): Promise<SemanticCriticOutcome> {
  const targets = semanticCriticTargets(prism, fragments);
  const selection = resolveOpponentSelection(config);

  if (selection === null) {
    // No host → deterministic shell only: stamp every covered node host_absent, no invocation.
    let next = prism;
    const degraded: string[] = [];
    for (const t of targets) {
      next = recordSemanticCritique(next, t.node_id, { status: 'host_absent' });
      degraded.push(t.node_id);
    }
    return {
      prism: next,
      host_available: false,
      selection: null,
      engaged: [],
      degraded,
      skipped_by_cap: 0,
    };
  }

  const cap = config.cap ?? OPPONENT_FANOUT_CAP;
  let next = prism;
  const engaged: string[] = [];
  const degraded: string[] = [];
  let invoked = 0;
  let skippedByCap = 0;

  for (const t of targets) {
    if (invoked >= cap) {
      skippedByCap += 1;
      continue;
    }
    invoked += 1;
    // Sequential await + per-node try/catch: a delegate throw is caught and mapped to the
    // SAME host_absent degrade as a null return (symmetry, no retry — failure-recovery finding).
    let text: string | null = null;
    try {
      text = await config.delegate({
        concern: 'semantic',
        node_id: t.node_id,
        label: labelOf(next, t.node_id),
        intent: config.intent,
        fragment: { id: t.fragment_id, text: fragmentTextOf(fragments, t.fragment_id) },
        selection,
      });
    } catch {
      text = null;
    }
    if (text && text.trim().length > 0) {
      next = recordSemanticCritique(next, t.node_id, { status: 'engaged', text });
      engaged.push(t.node_id);
    } else {
      next = recordSemanticCritique(next, t.node_id, { status: 'host_absent' });
      degraded.push(t.node_id);
    }
  }

  return {
    prism: next,
    host_available: true,
    selection,
    engaged,
    degraded,
    skipped_by_cap: skippedByCap,
  };
}

function fragmentTextOf(fragments: readonly IntentFragment[], fragmentId: string): string {
  return fragments.find((f) => f.id === fragmentId)?.text ?? '';
}
