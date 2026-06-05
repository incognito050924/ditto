import {
  type AcgSemanticCompatibility,
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

export interface SemanticSeedInput {
  workItemId: string;
  file: string;
  symbol: string;
  before: string;
  after: string;
  producedAt: string;
}

export function buildSemanticSeed(input: SemanticSeedInput): AcgSemanticCompatibility {
  return {
    schema_version: '0.1.0',
    kind: 'acg.semantic-compatibility.v1',
    work_item_id: input.workItemId,
    produced_by: 'agent',
    produced_at: input.producedAt,
    change: { before: input.before, after: input.after },
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

export interface SemanticVerdictInput {
  semanticSafe: 'yes' | 'no' | 'unverified';
  oldMeaning?: string;
  compatibility?: AcgSemanticCompatibility['compatibility'];
  intendedBreaking?: boolean;
  typeSafe?: boolean;
  modelVersion?: string;
  /**
   * Ref to a passing characterization (behavior) test that witnesses the meaning
   * is preserved. Schema requires it for an agent-produced `yes` (B / sv1 O6);
   * this is a citation of an EXISTING test, not a generation pipeline.
   */
  characterizationTestRef?: string;
}

/**
 * Inject an agent's meaning judgment onto a seed. Returns a candidate artifact;
 * the caller validates it with the schema (writeJson) so an unsubstantiated `yes`
 * or a left-over sentinel fails closed rather than clearing the gate.
 */
export function applySemanticVerdict(
  seed: AcgSemanticCompatibility,
  v: SemanticVerdictInput,
): AcgSemanticCompatibility {
  return {
    ...seed,
    old_meaning: v.oldMeaning ?? seed.old_meaning,
    compatibility: v.compatibility ?? seed.compatibility,
    ...(v.characterizationTestRef
      ? {
          characterization: {
            exists: true,
            test_ref: v.characterizationTestRef,
            candidate: null,
          },
        }
      : {}),
    verdict: {
      type_safe: v.typeSafe ?? seed.verdict.type_safe,
      semantic_safe: v.semanticSafe,
      ...(v.intendedBreaking !== undefined ? { intended_breaking: v.intendedBreaking } : {}),
      ...(v.modelVersion ? { reproducibility: { model_version: v.modelVersion } } : {}),
    },
  };
}
