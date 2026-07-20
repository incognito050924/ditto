import type { AcStatus } from './queue-state';
import type { CrossCheckOutcome } from '../verify/codex';

/**
 * §5 completion gate — "AC 2-facet". The mission (§4) forbids closing any
 * acceptance criterion by claim alone and demands an independent Codex
 * cross-check at disposition. So an AC is truly pass only when BOTH facets hold:
 *   facet 1 (LOCAL)   — its own outcome is pass AND it carries live evidence.
 *   facet 2 (EXTERNAL)— an independent cross-check verified it.
 * Making the two facets explicit lets re-lock routing act on whichever one
 * blocks. Pure, synchronous, fail-closed.
 */

export interface AcTwoFacetInput {
  id: string;
  status: AcStatus;
  evidence_ref: string | null;
  crossCheck: CrossCheckOutcome;
}

export interface AcTwoFacetVerdict {
  id: string;
  localFacet: 'pass' | 'blocked';
  externalFacet: 'pass' | 'blocked';
  verdict: 'pass' | 'blocked';
  reasons: string[];
}

const hasEvidence = (ref: string | null): boolean =>
  ref !== null && ref.trim().length > 0;

export function evaluateAcTwoFacet(input: AcTwoFacetInput): AcTwoFacetVerdict {
  const evidencePresent = hasEvidence(input.evidence_ref);
  const localPass = input.status === 'pass' && evidencePresent;
  const externalPass = input.crossCheck === 'verified';

  const reasons: string[] = [];
  if (!localPass) {
    reasons.push(
      `local facet blocked: status=${input.status}, evidence ${
        evidencePresent ? 'present' : 'absent'
      }`,
    );
  }
  if (!externalPass) {
    reasons.push(`external facet blocked: crossCheck=${input.crossCheck}`);
  }

  return {
    id: input.id,
    localFacet: localPass ? 'pass' : 'blocked',
    externalFacet: externalPass ? 'pass' : 'blocked',
    verdict: localPass && externalPass ? 'pass' : 'blocked',
    reasons,
  };
}
