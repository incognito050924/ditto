/**
 * Autopilot Tidy wiring (80-plan §8/§10, WU-3) — the runtime seam that turns the
 * already-built tidy primitives into a stage on the autopilot loop. When an
 * `implement` node goes green, the ⓪ classifier (`classifyTidyEntry`) decides
 * SKIP/ENTER from the just-made diff-stat; on ENTER the ④/⑦ tidy subgraph
 * (`buildTidySubgraph`) is generated for the driver to splice via
 * `AutopilotStore.addNodes` — the SAME splice path as planner `generated_nodes`.
 *
 * This module only DECIDES (pure): it never writes the graph and never runs git.
 * The loop computes the diff-stat (`collectTidyDiffStat`) fail-open and splices
 * the returned nodes. Keeping the decision pure keeps it unit-testable without a
 * repo and mirrors how `proposalsToNodes` separates derivation from the splice.
 */
import { type TidyDiffStat, classifyTidyEntry } from '~/acg/tidy/classifier';
import { buildTidySubgraph } from '~/acg/tidy/subgraph';
import type { TidyClassification } from '~/schemas/acg-tidy';
import type { AutopilotNode } from '~/schemas/autopilot';

export interface TidyPlanInput {
  /** The green implement node the tidy stage follows. */
  implementNodeId: string;
  /** Diff-stat of the just-made change (from `collectTidyDiffStat`). */
  diffStat: TidyDiffStat;
  /** Acceptance ids the ⑦ DoD-replay verify node carries (the implement node's). */
  acceptanceIds: string[];
  /** Existing node ids — the generated ids must not collide with these. */
  existingNodeIds: string[];
}

export interface TidyPlan {
  /** The ⓪ classifier verdict (left as an artifact by the caller). */
  classification: TidyClassification;
  /** The ④/⑦ subgraph to splice on ENTER; [] on SKIP. */
  nodes: AutopilotNode[];
}

/**
 * Decide the tidy stage for a green implement pass:
 * - run the ⓪ classifier on the diff-stat (deterministic; slop is not an input);
 * - SKIP → no nodes;
 * - ENTER → one parallel `refactor` cleanup node per touched CODE file (each with
 *   a DECLARED `file_scope` so the active-node lease can enforce it — §8 OBJ-06),
 *   plus the `verify` DoD-replay node carrying the implementation acceptance ids.
 *
 * The id prefix is derived from the implement node id (`<impl>t`) so the generated
 * ids do not collide with the base graph or a sibling implement node's tidy stage.
 */
/**
 * Derive the pathspec that scopes the tidy diff to THIS work item's own change
 * surface: the deduped union of the plan's declared `change_surface` and the work
 * item's `changed_files`. Passing this to `collectTidyDiffStat` keeps another
 * session's committed files (absent from the surface) out of the diff-stat, so
 * they never spawn a spurious refactor node (wi_260709ft1). An empty union yields
 * `[]`, which `collectTidyDiffStat` treats as the unscoped legacy fallback.
 */
export function deriveTidyScope(changeSurface: string[], changedFiles: string[]): string[] {
  return [...new Set([...changeSurface, ...changedFiles])];
}

export function planTidyOnImplementPass(input: TidyPlanInput): TidyPlan {
  const classification = classifyTidyEntry(input.diffStat);
  if (classification.decision === 'SKIP') {
    return { classification, nodes: [] };
  }
  // ENTER: one cleanup node per touched CODE file (docs/config are not tidied —
  // they are not behaviour-preserving refactor targets). One file per batch keeps
  // each node's lease tight and the parallel wave maximally independent.
  const codeFiles = input.diffStat.files.filter((f) => f.isCode).map((f) => f.path);
  const fileBatches = codeFiles.map((path) => [path]);
  const nodes = buildTidySubgraph({
    implementNodeId: input.implementNodeId,
    fileBatches,
    acceptanceIds: input.acceptanceIds,
    idPrefix: `${input.implementNodeId}t`,
  });
  return { classification, nodes };
}
