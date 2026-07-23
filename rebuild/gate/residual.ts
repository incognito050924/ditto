import type {
  AcceptanceCriterion,
  DeclaredRisk,
} from '../schemas/work-item-record';

/**
 * Pass-close residual gate: a `final_verdict=pass` close is inadmissible
 * while in-scope agent-owned residue remains on either surface —
 * unverified/failed acceptance criteria, or declared risks not yet disposed.
 *
 * capture≠drive: out-of-scope follow-ups materialized to their own ledger
 * (their own work items) do not live on these surfaces, so capturing them is
 * a valid disposition — the gate targets silent scope-shrink only.
 *
 * Presence-keyed grandfather: an ABSENT surface (undefined) never blocks —
 * records that predate the surface close as-is; only a present, non-empty
 * surface is residue.
 */

/** In-scope unverified residue: not pass and not superseded. */
export function unverifiedCriterionIds(
  criteria: AcceptanceCriterion[],
): string[] {
  return criteria
    .filter((c) => c.superseded !== true && c.verdict !== 'pass')
    .map((c) => c.id);
}

/** Undisposed declared risks; absent disposition means open. */
export function openRiskStatements(risks: DeclaredRisk[]): string[] {
  return risks
    .filter((r) => r.disposition !== 'accepted' && r.disposition !== 'mitigated')
    .map((r) => r.statement);
}

export interface ResidualSurfaces {
  unverified?: string[] | undefined;
  open_risks?: string[] | undefined;
}

export interface ResidualGateResult {
  decision: 'pass' | 'block';
  blockers: { unverified: string[]; open_risks: string[] };
}

export function passCloseResidualGate(
  surfaces: ResidualSurfaces,
): ResidualGateResult {
  const blockers = {
    unverified: surfaces.unverified ?? [],
    open_risks: surfaces.open_risks ?? [],
  };
  const blocked =
    blockers.unverified.length > 0 || blockers.open_risks.length > 0;
  return { decision: blocked ? 'block' : 'pass', blockers };
}
