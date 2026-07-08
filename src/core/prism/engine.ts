import {
  type CapUsage,
  type CoverageCaps,
  capStatus,
  closeNode,
  coverageClosureGate,
} from '~/core/coverage-manager';
import type { CoverageNode } from '~/schemas/coverage';
import type { PrismIssueMap, PrismSeverity } from '~/schemas/prism';

/**
 * Prism issue-map engine (wi_260707oi1, node oi1-issuemap-engine).
 *
 * NET-NEW prism logic ONLY. The tree CRUD / close / false-green gate / cap
 * evaluation are REUSED from `coverage-manager.ts` (design decision 1: never
 * re-implement a third tree engine). This module adds the four prism concerns:
 *   - ac-2  criticalTermination (B1 vacuous-truth guard) + severity authority
 *           (MODEL-2) + unknown-close residual gate (MODEL-1);
 *   - ac-3  label-only progress summary (no id / axis / schema-field leak);
 *   - ac-4  one-shot minimal-launch notification with retract-on-regression;
 *   - ac-10 deterministic divergence detection + real cap-invocation loop.
 */

// ── severity authority (MODEL-2) ─────────────────────────────────────────────

/**
 * Effective severity of a node. Default `noncritical` — `critical` is granted only
 * by an explicit gated assignment, so the actor who benefits from the launch gate
 * cannot make a node critical (or drop it) by side-effect.
 */
export function severityOf(prism: PrismIssueMap, nodeId: string): PrismSeverity {
  return prism.severities.find((s) => s.node_id === nodeId)?.severity ?? 'noncritical';
}

export interface PrismGateResult {
  ok: boolean;
  prism?: PrismIssueMap;
  reasons: string[];
}

/**
 * MODEL-2 severity authority gate. Assign `critical`/`noncritical` to a node. A
 * critical→noncritical DEMOTION must carry an explicit reason (isomorphic to a
 * non-resolved close's residual_risk) — a silent demotion is rejected. Pure.
 */
export function assignSeverity(
  prism: PrismIssueMap,
  nodeId: string,
  severity: PrismSeverity,
  reason?: string,
): PrismGateResult {
  if (!prism.tree.nodes.some((n) => n.id === nodeId)) {
    return { ok: false, reasons: [`unknown prism node id: ${nodeId}`] };
  }
  const current = severityOf(prism, nodeId);
  const isDemotion = current === 'critical' && severity === 'noncritical';
  if (isDemotion && (reason === undefined || reason.trim().length === 0)) {
    return {
      ok: false,
      reasons: [
        `critical→noncritical demotion of ${nodeId} requires an explicit reason (MODEL-2 — a severity demotion is decision-grade, never silent)`,
      ],
    };
  }
  const others = prism.severities.filter((s) => s.node_id !== nodeId);
  const assignment = {
    node_id: nodeId,
    severity,
    ...(isDemotion ? { demotion_reason: reason } : {}),
  };
  return { ok: true, prism: { ...prism, severities: [...others, assignment] }, reasons: [] };
}

// ── close gate (MODEL-1 unknown-close residual) ──────────────────────────────

/** An unknown-close state — a "모름-닫기" that defers rather than resolves. */
function isUnknownCloseState(state: Exclude<CoverageNode['state'], 'open'>): boolean {
  return state === 'out_of_scope' || state === 'user_owned';
}

/**
 * Close a prism node through the coverage-manager machinery, adding the prism
 * gates:
 *   - false-green gate (coverageClosureGate) — reused, no re-implement;
 *   - MODEL-1: an unknown-close (out_of_scope/user_owned) of a CRITICAL node
 *     requires a recorded residual_risk. A no-residual "모름-닫기" of critical
 *     scope is REJECTED (it must not silently count as critical resolution).
 * Pure: returns the new prism on success, reasons on rejection.
 */
export function closePrismNode(
  prism: PrismIssueMap,
  nodeId: string,
  state: Exclude<CoverageNode['state'], 'open'>,
  reason?: string,
  residualRisk?: string,
): PrismGateResult {
  const gate = coverageClosureGate(prism.tree, nodeId, state);
  if (!gate.pass) return { ok: false, reasons: gate.reasons };
  const isCritical = severityOf(prism, nodeId) === 'critical';
  const noResidual = residualRisk === undefined || residualRisk.trim().length === 0;
  if (isCritical && isUnknownCloseState(state) && noResidual) {
    return {
      ok: false,
      reasons: [
        `unknown-close (${state}) of critical node ${nodeId} requires a recorded residual_risk — a no-residual "모름-닫기" of critical scope is rejected and never counts as critical resolution (MODEL-1)`,
      ],
    };
  }
  const tree = closeNode(prism.tree, nodeId, state, reason, residualRisk);
  return { ok: true, prism: { ...prism, tree }, reasons: [] };
}

// ── ac-2 critical termination (B1 vacuous-truth guard) ───────────────────────

/**
 * MODEL-1 산입 rule: a critical node counts as RESOLVED when it is `resolved`, OR
 * when it is an unknown-close (out_of_scope/user_owned) that carries a recorded
 * residual_risk. A no-residual unknown-close does NOT count (double-checked here
 * even though closePrismNode already rejects it).
 */
function isCriticalResolved(node: CoverageNode): boolean {
  if (node.state === 'open') return false;
  if (node.state === 'resolved') return true;
  return node.residual_risk !== undefined && node.residual_risk.trim().length > 0;
}

export interface CriticalTerminationVerdict {
  terminated: boolean;
  reason: string;
}

/**
 * ac-2 critical termination: minimal-launch is reachable when every CRITICAL node
 * is resolved. Non-critical survivors do NOT block termination (the user's call).
 *
 * B1 vacuous-truth guard: `every()` over an EMPTY critical set is `true`, which
 * would make a 0-critical / empty map falsely report terminated (and then fire the
 * launch notification). So termination fires ONLY when the map has actually been
 * explored (≥1 node) AND carries ≥1 critical node — a 0-critical / empty map never
 * terminates or notifies.
 */
export function criticalTermination(prism: PrismIssueMap): CriticalTerminationVerdict {
  if (prism.tree.nodes.length === 0) {
    return {
      terminated: false,
      reason: 'empty map — no scope explored yet (B1 vacuous-truth guard)',
    };
  }
  const criticalIds = new Set(
    prism.severities.filter((s) => s.severity === 'critical').map((s) => s.node_id),
  );
  const criticalNodes = prism.tree.nodes.filter((n) => criticalIds.has(n.id));
  if (criticalNodes.length === 0) {
    return {
      terminated: false,
      reason:
        'no critical nodes — termination/notification does NOT fire on a 0-critical map (B1 vacuous-truth guard)',
    };
  }
  const unresolved = criticalNodes.filter((n) => !isCriticalResolved(n));
  if (unresolved.length > 0) {
    return {
      terminated: false,
      reason: `${unresolved.length} critical node(s) still unresolved`,
    };
  }
  return {
    terminated: true,
    reason: 'every critical node resolved (non-critical scope may survive — the user decides)',
  };
}

// ── ac-4 minimal-launch notification (one-shot + retract on regression) ───────

/**
 * The user-facing minimal-launch line — everyday language, no ids / jargon / hooks.
 * This is a CONSOLE announcement (ac-4: 질문 훅 절대 미사용), emitted once.
 */
export const MINIMAL_LAUNCH_MESSAGE =
  '핵심으로 꼭 정해야 할 것은 모두 정리됐어요. 지금 최소한으로 착수할 수 있어요. (남은 항목은 착수하면서 정해도 됩니다.)';

export interface LaunchNotification {
  prism: PrismIssueMap;
  /** Emit the one-shot console message NOW. */
  notify: boolean;
  /** A prior notification was CLEARED because the map regressed (new/reopened critical). */
  retracted: boolean;
  message?: string;
}

/**
 * ac-4 launch-notification state machine. When critical scope becomes all-resolved
 * (non-critical may survive) and we have NOT yet notified → announce once and stamp
 * `notified_at` (durable one-shot). When the map has regressed out of termination
 * yet still carries a stamp → RETRACT it (clear `notified_at`) so re-reaching
 * re-announces. Pure; the caller owns the console write + persistence.
 */
export function resolveLaunchNotification(prism: PrismIssueMap, now: Date): LaunchNotification {
  const { terminated } = criticalTermination(prism);
  const alreadyNotified = prism.notified_at !== undefined;
  if (terminated) {
    if (alreadyNotified) return { prism, notify: false, retracted: false };
    return {
      prism: { ...prism, notified_at: now.toISOString() },
      notify: true,
      retracted: false,
      message: MINIMAL_LAUNCH_MESSAGE,
    };
  }
  if (alreadyNotified) {
    const { notified_at: _dropped, ...rest } = prism;
    return { prism: rest as PrismIssueMap, notify: false, retracted: true };
  }
  return { prism, notify: false, retracted: false };
}

// ── ac-3 label-only progress summary ─────────────────────────────────────────

/**
 * ac-3 progress summary — the labels of the still-open items, and NOTHING else.
 * Deliberately NOT `serializePlanDialog` (that renders node ids). No node id, no
 * severity enum, no coverage axis name, no schema field leaks — only the
 * natural-language `label`, so the user reads plain scope, not internals. The root
 * container (root_id) is excluded — it is the intent frame, not a remaining item.
 */
export function renderProgressSummary(prism: PrismIssueMap): string[] {
  return prism.tree.nodes
    .filter((n) => n.state === 'open' && n.id !== prism.tree.root_id)
    .map((n) => n.label);
}

// ── ac-10 divergence detection + cap-invocation loop ─────────────────────────

/** Normalize a question/challenge signature so trivial variants collapse to one key. */
function normalizeSignature(signature: string): string {
  return signature.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Consecutive trivial-question streak that trips a divergence flag. */
export const TRIVIAL_STREAK_CAP = 3;

export type DivergenceKind = 'repeat_question' | 'trivial_streak' | 'decided_conflict_no_evidence';

export interface DivergenceVerdict {
  diverged: boolean;
  kind?: DivergenceKind;
  /** What to do — never a silent drop: cap-stop escalates, challenge-node admits, continue proceeds. */
  action: 'cap-stop' | 'challenge-node' | 'continue';
  reason: string;
}

export interface PrismRoundSignature {
  signature: string;
  trivial: boolean;
}

export interface PrismChallenge {
  /** The already-decided item this challenge contests. */
  decided_id: string;
  signature: string;
  /** true = the re-challenge brings NEW grounding evidence (admissible once). */
  new_evidence: boolean;
}

export interface PrismRound {
  /** Nodes this round appended to the tree (for the tree-node cap). */
  addedNodeCount?: number;
  question?: PrismRoundSignature;
  challenge?: PrismChallenge;
}

/**
 * ac-10 deterministic divergence detection. Flags — WITHOUT any LLM call — the
 * three meaningless-divergence shapes the design names:
 *   - repeat_question: a near-duplicate of an earlier question (쳇바퀴, no new signal);
 *   - trivial_streak:  TRIVIAL_STREAK_CAP consecutive trivial questions;
 *   - decided_conflict_no_evidence: re-challenging a decided item with NO new evidence.
 * A challenge WITH new evidence is admissible → routes to a VISIBLE challenge node
 * (once), never a silent suppression. Pure and deterministic.
 */
export function detectDivergence(
  round: PrismRound,
  history: readonly PrismRoundSignature[],
): DivergenceVerdict {
  if (round.challenge) {
    if (round.challenge.new_evidence) {
      return {
        diverged: false,
        action: 'challenge-node',
        reason: `challenge to decided ${round.challenge.decided_id} carries NEW evidence — admit as a visible challenge node (once)`,
      };
    }
    return {
      diverged: true,
      kind: 'decided_conflict_no_evidence',
      action: 'cap-stop',
      reason: `re-challenge to decided ${round.challenge.decided_id} with no new evidence — flagged divergence (visibly suppressed, not silent)`,
    };
  }
  if (round.question) {
    const key = normalizeSignature(round.question.signature);
    if (history.some((h) => normalizeSignature(h.signature) === key)) {
      return {
        diverged: true,
        kind: 'repeat_question',
        action: 'cap-stop',
        reason: 'near-duplicate of an earlier question — repeated with no new signal (쳇바퀴)',
      };
    }
    if (round.question.trivial) {
      let streak = 1;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i]?.trivial) streak += 1;
        else break;
      }
      if (streak >= TRIVIAL_STREAK_CAP) {
        return {
          diverged: true,
          kind: 'trivial_streak',
          action: 'cap-stop',
          reason: `${streak} consecutive trivial questions — flagged divergence`,
        };
      }
    }
  }
  return { diverged: false, action: 'continue', reason: 'no divergence signal' };
}

/**
 * Default prism caps (§8.2-style — node/event/round upper bounds). A cap hit is a
 * STOP+escalate, never success (cap ≠ converged). Configurable by the caller.
 */
export const PRISM_CAPS: CoverageCaps = {
  callsPerNode: 8,
  treeNodeCount: 60,
  totalRounds: 40,
};

export interface PrismDriveResult {
  roundsRun: number;
  treeNodeCount: number;
  /** A cap was reached → the loop stopped and escalated (NOT termination/success). */
  halted: boolean;
  /** Cap reasons when halted (empty otherwise) — cap ≠ converged. */
  escalation: string[];
  /** Every divergence verdict observed, in order (visible, never silent). */
  divergences: DivergenceVerdict[];
}

/**
 * ac-10 cap-invocation loop. Drives the interview rounds and — this is the point —
 * ACTUALLY CALLS `capStatus` (the reused coverage cap evaluator) BEFORE each round.
 * The moment any cap is reached the loop HALTS and escalates; it does NOT keep
 * running or report success (cap ≠ converged, cap ≠ termination). Deterministic;
 * the caller supplies the already-produced rounds and the caps.
 */
export function runPrismRounds(
  rounds: readonly PrismRound[],
  caps: CoverageCaps = PRISM_CAPS,
  start: Partial<CapUsage> = {},
): PrismDriveResult {
  let usage: CapUsage = {
    callsThisNode: start.callsThisNode ?? 0,
    treeNodeCount: start.treeNodeCount ?? 0,
    roundsRun: start.roundsRun ?? 0,
  };
  const history: PrismRoundSignature[] = [];
  const divergences: DivergenceVerdict[] = [];
  for (const round of rounds) {
    // REAL cap call every iteration, BEFORE processing the round.
    const cap = capStatus(caps, usage);
    if (cap.capped) {
      return {
        roundsRun: usage.roundsRun,
        treeNodeCount: usage.treeNodeCount,
        halted: true,
        escalation: cap.reasons,
        divergences,
      };
    }
    if (round.question || round.challenge) {
      divergences.push(detectDivergence(round, history));
      if (round.question) history.push(round.question);
    }
    usage = {
      ...usage,
      treeNodeCount: usage.treeNodeCount + (round.addedNodeCount ?? 0),
      roundsRun: usage.roundsRun + 1,
    };
  }
  return {
    roundsRun: usage.roundsRun,
    treeNodeCount: usage.treeNodeCount,
    halted: false,
    escalation: [],
    divergences,
  };
}
