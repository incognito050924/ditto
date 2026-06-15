import {
  type AcgSemanticCompatibility,
  type AcgSemanticCompatibilityChange,
  SEMANTIC_UNVERIFIED_SENTINEL,
} from '~/schemas/acg-semantic-compatibility';

/**
 * OBJ-43 (wi_260605sv1) — SemanticCompatibility producer core.
 *
 * The pipeline splits along the static/meaning boundary the dialectic confirmed:
 *  - `buildSemanticSeed` is the STATIC layer. It records the signature pair as a
 *    fact and leaves the meaning `unverified` (sentinel `old_meaning`, conservative
 *    `breaking`). The seed alone forces continuation at the stop gate
 *    (stop.ts:242), so a signature change cannot silently clear.
 *  - `applySemanticVerdict` is the RESOLVER layer. An agent runs the meaning
 *    judgment (ditto never calls an LLM — ADR-0001) and injects it here, replacing
 *    the sentinel with the real meaning and, for a `yes`, a pinned judge model.
 *    Schema validation at write time is the fail-closed enforcer (dialectic-1 O5).
 */

export interface SemanticSeedPair {
  before: string;
  after: string;
}

export interface SemanticSeedInput {
  workItemId: string;
  /** One or more detected signature pairs — the detector finds all (G4). */
  changes: SemanticSeedPair[];
  producedAt: string;
}

/** An unverified per-pair seed change. Meaning left for the resolver. */
function buildSeedChange(pair: SemanticSeedPair): AcgSemanticCompatibilityChange {
  return {
    before: pair.before,
    after: pair.after,
    // Meaning is not statically derivable; the resolver fills it. The sentinel is
    // schema-valid only while `unverified`.
    old_meaning: SEMANTIC_UNVERIFIED_SENTINEL,
    business_assumptions: [],
    // Conservative default: a signature change is potentially breaking until an
    // agent judges otherwise (fail-closed).
    compatibility: 'breaking',
    verdict: { type_safe: true, semantic_safe: 'unverified' },
  };
}

export function buildSemanticSeed(input: SemanticSeedInput): AcgSemanticCompatibility {
  return {
    schema_version: '0.1.0',
    kind: 'acg.semantic-compatibility.v1',
    work_item_id: input.workItemId,
    produced_by: 'agent',
    produced_at: input.producedAt,
    changes: input.changes.map(buildSeedChange),
  };
}

export interface SemanticVerdictInput {
  semanticSafe: 'yes' | 'no' | 'unverified';
  oldMeaning?: string;
  compatibility?: AcgSemanticCompatibilityChange['compatibility'];
  intendedBreaking?: boolean;
  typeSafe?: boolean;
  modelVersion?: string;
  /**
   * Ref to a passing characterization (behavior) test that witnesses the meaning
   * is preserved. Schema requires it for an agent-produced `yes` (B / sv1 O6);
   * this is a citation of an EXISTING test, not a generation pipeline.
   */
  characterizationTestRef?: string;
  /**
   * Adequacy of the cited characterization (OBJ-11): 'l1_met' (test executes the
   * changed region) or 'l2_passed' (old↔new differential passed). Required for an
   * agent-produced `yes` — a bare ref (default 'none') no longer clears the gate.
   */
  characterizationAdequacy?: 'l1_met' | 'l2_passed';
  /**
   * Which pair to resolve when the artifact holds several (G4 multi-change),
   * identified by its before/after. Omitted resolves the sole pair; ambiguous or
   * unmatched throws so a verdict cannot silently land on the wrong change.
   */
  target?: SemanticSeedPair;
}

/** Resolve which change a verdict targets; throws when ambiguous/unmatched. */
function selectChangeIndex(seed: AcgSemanticCompatibility, target?: SemanticSeedPair): number {
  if (!target) {
    if (seed.changes.length !== 1) {
      throw new Error(
        `semantic verdict: ${seed.changes.length} changes present; specify which pair (--before/--after) to resolve`,
      );
    }
    return 0;
  }
  const idx = seed.changes.findIndex((c) => c.before === target.before && c.after === target.after);
  if (idx < 0) {
    throw new Error(`semantic verdict: no change matching "${target.before}" → "${target.after}"`);
  }
  return idx;
}

/**
 * Inject an agent's meaning judgment onto ONE pair of a seed. Returns a candidate
 * artifact; the caller validates it with the schema (writeJson) so an
 * unsubstantiated `yes` or a left-over sentinel fails closed rather than clearing
 * the gate. Other pairs are untouched, so an unresolved pair keeps blocking (G4).
 */
export function applySemanticVerdict(
  seed: AcgSemanticCompatibility,
  v: SemanticVerdictInput,
): AcgSemanticCompatibility {
  const idx = selectChangeIndex(seed, v.target);
  const prior = seed.changes[idx] as AcgSemanticCompatibilityChange;
  const resolved: AcgSemanticCompatibilityChange = {
    ...prior,
    old_meaning: v.oldMeaning ?? prior.old_meaning,
    compatibility: v.compatibility ?? prior.compatibility,
    ...(v.characterizationTestRef
      ? {
          characterization: {
            exists: true,
            test_ref: v.characterizationTestRef,
            candidate: null,
            adequacy: v.characterizationAdequacy ?? 'none',
          },
        }
      : {}),
    verdict: {
      type_safe: v.typeSafe ?? prior.verdict.type_safe,
      semantic_safe: v.semanticSafe,
      ...(v.intendedBreaking !== undefined ? { intended_breaking: v.intendedBreaking } : {}),
      ...(v.modelVersion ? { reproducibility: { model_version: v.modelVersion } } : {}),
    },
  };
  return {
    ...seed,
    changes: seed.changes.map((c, i) => (i === idx ? resolved : c)),
  };
}
