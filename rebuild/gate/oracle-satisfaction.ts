import type { Evidence, EvidenceKind } from '../schemas/evidence';
import { decideGate, type GateResult } from '../schemas/gate-result';
import type { AcOracle, VerificationMethod } from '../schemas/oracle';

/**
 * Oracle satisfaction: an AC's oracle is satisfied only by evidence of the
 * class that oracle's verification method demands — presence-gated and
 * fail-closed via the decideGate primitive. A green test cannot close a
 * static_scan oracle, an artifact cannot close a dynamic_test oracle, and no
 * evidence at all always blocks.
 */

const ACCEPTED_EVIDENCE: Record<VerificationMethod, readonly EvidenceKind[]> = {
  dynamic_test: ['test', 'command'],
  // re-scan artifact anchor — absent analyzer output means unverified, never pass
  static_scan: ['file'],
  // review / observed behavior / user decision
  soft_judgment: ['behavior', 'repro'],
};

export function oracleSatisfaction(
  oracle: AcOracle,
  evidence: Evidence[],
): GateResult {
  const accepted = ACCEPTED_EVIDENCE[oracle.verification_method];
  const match = evidence.find((e) => accepted.includes(e.kind));
  if (match === undefined) return decideGate({});
  return decideGate({
    outcome: 'pass',
    grounds: `${oracle.verification_method} oracle "${oracle.statement}" satisfied by ${match.kind} evidence (${match.path ?? match.hash ?? ''}): ${match.summary}`,
  });
}
