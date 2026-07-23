/**
 * Decision-conflict routing gate. Detecting a conflict and judging its
 * kind/level is the host LLM's job — this module only encodes the
 * deterministic routing and the transparency invariant:
 *
 * - prefer            → justify   (weak preference: record why, never block)
 * - method forbid/req → align     (the agent follows the ADR; no user round-trip)
 * - intent            → ask_user  (interactive) / block (autopilot — fail-closed,
 *                                  never a live wait)
 *
 * Transparency: every routed conflict carries its basis. Silent
 * auto-compliance — aligning without disclosing — is itself a violation, so
 * an empty basis is refused outright.
 */

export type ConflictKind = 'forbid' | 'require' | 'prefer';
export type ConflictLevel = 'intent' | 'method';
export type GateMode = 'interactive' | 'autopilot';

export interface DecisionConflict {
  /** The decision record in conflict (e.g. an ADR identifier). */
  adr: string;
  kind: ConflictKind;
  level: ConflictLevel;
  /** Why this is a conflict — carried through to the rendered disposition. */
  basis: string;
}

export type ConflictDisposition = 'justify' | 'align' | 'ask_user' | 'block';

export interface RoutedConflict {
  conflict: DecisionConflict;
  disposition: ConflictDisposition;
  basis: string;
}

export function routeDecisionConflict(
  conflict: DecisionConflict,
  mode: GateMode,
): RoutedConflict {
  if (conflict.basis.trim().length === 0) {
    throw new Error(
      `decision conflict with ${conflict.adr} has an empty basis — routing without disclosed basis is silent auto-compliance`,
    );
  }
  const disposition: ConflictDisposition =
    conflict.kind === 'prefer'
      ? 'justify'
      : conflict.level === 'method'
        ? 'align'
        : mode === 'interactive'
          ? 'ask_user'
          : 'block';
  return { conflict, disposition, basis: conflict.basis };
}

export interface DecisionConflictGateResult {
  decision: 'pass' | 'block';
  routed: RoutedConflict[];
}

/**
 * Completion-path enforcement: justify/align pass (with disclosed basis);
 * any intent-level conflict makes autonomous pass-close inadmissible — in
 * interactive mode it awaits the user (ask_user), in autopilot it blocks.
 */
export function decisionConflictGate(
  conflicts: DecisionConflict[],
  mode: GateMode,
): DecisionConflictGateResult {
  const routed = conflicts.map((c) => routeDecisionConflict(c, mode));
  const blocked = routed.some(
    (r) => r.disposition === 'ask_user' || r.disposition === 'block',
  );
  return { decision: blocked ? 'block' : 'pass', routed };
}
