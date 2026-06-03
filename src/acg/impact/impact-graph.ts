import type { AcgAffectedNode, AcgImpactGraph } from '~/schemas/acg-impact-graph';
import { acgImpactGraph } from '~/schemas/acg-impact-graph';

/**
 * ImpactGraph producer — governance core (단계3, 10-methodology.md §3).
 *
 * The *analyzer* (symbol → caller/type/export graph) is the BINDING's job and is
 * language-specific (10-methodology.md:82); it is injected. This module owns the
 * language-agnostic GOVERNANCE invariant the spec actually gates on:
 *
 *   default-deny (20-contracts.md:212, OBJ-15/17): a USER-EXPOSED change must
 *   either map to a JourneySpec.id (a ui_surface/user_journey affected node) OR
 *   emit `unresolved: journey_unknown`. A user-exposed diff with neither cannot
 *   pass — under-recording impact must not slip through in silence.
 *
 * Statically-unresolvable impact (dynamic dispatch, reflection, config, cross
 * repo) the analyzer reports as `unresolved`; a binding that has not wired a
 * caller-graph provider also lands its impact in `unresolved` (never hidden).
 */

/** What an analyzer observes; the producer adds envelope + the journey invariant. */
export interface AnalyzerResult {
  affected: Array<Omit<AcgAffectedNode, 'handled'> & { handled?: boolean }>;
  unresolved: AcgImpactGraph['unresolved'];
}

/** Binding-provided, language-specific impact analyzer (TS, JVM, …). */
export interface ImpactAnalyzer {
  analyze(input: { changeTarget: string; sourceRoot: string }): Promise<AnalyzerResult>;
}

export interface ImpactGraphInput {
  workItemId: string;
  changeTarget: string;
  changeType: AcgImpactGraph['change_type'];
  producedAt: string;
  /** Set when the diff touches a user-facing surface (route/component/UI endpoint, screen/e2e acceptance). */
  userExposed?: boolean;
  /** JourneySpec.id when the user-facing surface is mapped; absent ⇒ default-deny fires. */
  journeyId?: string;
}

const journeyKinds = new Set(['ui_surface', 'user_journey']);

/**
 * Assemble a schema-valid ImpactGraph from an analyzer result, applying the
 * default-deny journey invariant. Pure; validated against `acgImpactGraph`.
 */
export function buildImpactGraph(
  input: ImpactGraphInput,
  analysis: AnalyzerResult,
): AcgImpactGraph {
  const affected = analysis.affected.map((n) => ({ handled: false, ...n }));
  const unresolved = [...analysis.unresolved];

  // default-deny: a user-exposed change must be journey-mapped or journey_unknown.
  const hasJourneyNode = affected.some((n) => journeyKinds.has(n.kind) && n.journey_id);
  if (input.userExposed === true) {
    if (input.journeyId) {
      affected.push({
        kind: 'user_journey',
        journey_id: input.journeyId,
        reason: 'user-exposed change mapped to journey',
        handled: false,
      });
    } else if (!hasJourneyNode) {
      unresolved.push({
        kind: 'journey_unknown',
        path: input.changeTarget,
        reason:
          'user-exposed change with no JourneySpec mapping; a human must map the journey or declare no journey impact (default-deny, 20-contracts §2)',
      });
    }
  }

  return acgImpactGraph.parse({
    schema_version: '0.1.0',
    kind: 'acg.impact-graph.v1',
    work_item_id: input.workItemId,
    produced_by: 'agent',
    produced_at: input.producedAt,
    change_target: input.changeTarget,
    change_type: input.changeType,
    affected_nodes: affected,
    unresolved,
  });
}

/** Run a binding analyzer then assemble the governed graph. */
export async function produceImpactGraph(
  input: ImpactGraphInput,
  analyzer: ImpactAnalyzer,
  sourceRoot: string,
): Promise<AcgImpactGraph> {
  const analysis = await analyzer.analyze({ changeTarget: input.changeTarget, sourceRoot });
  return buildImpactGraph(input, analysis);
}
