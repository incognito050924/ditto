import { sha256Hex } from '~/core/evidence-store';
import type { AcgSemanticScanObservation } from '~/schemas/acg-semantic-scan-observation';
import type { WorkItem } from '~/schemas/work-item';
import type { SignatureChange } from './signature-codeql';

/**
 * Base ref candidates for a work item, in priority order: the work item's start
 * sha, then the usual remote/local mains. Mirrors the handoff fallback chain
 * (dialectic-1 OBJ-4). Pure — resolution (pickBaseRef) is the caller's.
 */
export function workItemBaseCandidates(workItem: Pick<WorkItem, 'started_at_sha'>): string[] {
  const candidates: string[] = [];
  if (workItem.started_at_sha) candidates.push(workItem.started_at_sha);
  candidates.push('origin/main', 'origin/master', 'main', 'master');
  return candidates;
}

/**
 * O2/O8 (wi_260605aw1 S2) — pure helpers for the non-gated scan observation.
 *
 * fingerprint = sha256(base sha + the full diff vs base). Same fingerprint ⇒ the
 * tree is byte-identical relative to the base, so the (expensive) CodeQL scan can
 * be skipped and the prior observation reused (dialectic-1 OBJ-1).
 */

export function computeScanFingerprint(baseSha: string, diffText: string): string {
  return sha256Hex(`${baseSha}\n${diffText}`);
}

export interface BuildObservationInput {
  workItemId: string;
  baseUsed: string;
  language: string;
  sourceRoot: string;
  fingerprint: string;
  changes: SignatureChange[];
  producedAt: string;
}

export function buildScanObservation(input: BuildObservationInput): AcgSemanticScanObservation {
  return {
    schema_version: '0.1.0',
    kind: 'acg.semantic-scan-observation.v1',
    work_item_id: input.workItemId,
    produced_by: 'agent',
    produced_at: input.producedAt,
    base_used: input.baseUsed,
    language: input.language,
    source_root: input.sourceRoot,
    fingerprint: input.fingerprint,
    change_count: input.changes.length,
    changes: input.changes.map((c) => ({
      file: c.file,
      symbol: c.symbol,
      before: c.before,
      after: c.after,
    })),
  };
}
