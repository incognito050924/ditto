import { z } from 'zod';

/**
 * Structural anchor (guardrail ②-anchor) — an INDEPENDENT cross-check that a
 * change's shape MATCHES the locked acceptance-criteria structure. This is
 * SEPARATE from a test pass: a test can be green while the change produced the
 * wrong shape (renamed file, missing symbol, wrong artifact). The anchor asks a
 * different question — "did the change actually produce the structure the locked
 * AC promised?" — so a green test on the wrong structure is still caught.
 *
 * Pure, deterministic, fail-closed: no I/O, no LLM. The locked expectations and
 * the observed shape are passed in; the caller collects them at their boundary.
 */

export const structuralKind = z.enum(['file', 'symbol', 'shape']);
export type StructuralKind = z.infer<typeof structuralKind>;

/** One structural promise a locked AC makes: a named artifact the change must produce. */
export const structuralExpectation = z
  .object({
    criterion_id: z.string().min(1),
    kind: structuralKind,
    target: z.string().min(1),
  })
  .strict();
export type StructuralExpectation = z.infer<typeof structuralExpectation>;

/** One artifact the change was actually observed to produce. */
export const observedStructure = z
  .object({
    kind: structuralKind,
    target: z.string().min(1),
  })
  .strict();
export type ObservedStructure = z.infer<typeof observedStructure>;

export type AnchorStatus = 'matched' | 'mismatch' | 'unverified';

export interface StructuralAnchorResult {
  status: AnchorStatus;
  // Locked expectations the observed change failed to produce.
  missing: StructuralExpectation[];
  reasons: string[];
}

const key = (kind: StructuralKind, target: string): string => `${kind}::${target}`;

export function checkStructuralAnchor(
  expected: StructuralExpectation[],
  observed: ObservedStructure[],
): StructuralAnchorResult {
  // fail-closed: an anchor given nothing to check cannot vouch for structure.
  if (expected.length === 0) {
    return {
      status: 'unverified',
      missing: [],
      reasons: ['structural anchor: no locked expectations to check → unverified'],
    };
  }

  const observedKeys = new Set(observed.map((o) => key(o.kind, o.target)));
  const missing = expected.filter((e) => !observedKeys.has(key(e.kind, e.target)));
  const reasons = missing.map(
    (m) =>
      `structural mismatch: ${m.criterion_id} promised ${m.kind} "${m.target}", but the change did not produce it`,
  );

  return {
    status: missing.length === 0 ? 'matched' : 'mismatch',
    missing,
    reasons,
  };
}
