/**
 * ④ + ⑦ Tidy subgraph (80-plan §8, WU-3). The "tidy stage": when the ⓪ classifier
 * returns ENTER after an implement node goes green, the planner/driver appends this
 * subgraph — one parallel cleanup node per file batch, then a DoD-replay verify.
 *
 * NO new nodeKind: a behaviour-preserving cleanup node IS a `refactor` node (its
 * owner `refactorer` is the Tidy-First restructurer). Parallel isolation is the
 * per-node `file_scope` lease (§8 — the truth-source for node scope, not
 * forbidden_scope). The cleanup nodes carry no acceptance_refs (they preserve
 * behaviour, they do not close criteria); the verify node replays the DoD.
 */
import { kindToOwner } from '~/core/autopilot-graph';
import type { AutopilotNode } from '~/schemas/autopilot';

export interface TidySubgraphInput {
  /** The green implement node the tidy pass follows (cleanup nodes depend on it). */
  implementNodeId: string;
  /** One file batch per parallel cleanup node; each becomes a node's file_scope. */
  fileBatches: string[][];
  /** Acceptance ids the DoD-replay verify node carries (⊆ the intent's). */
  acceptanceIds: string[];
  /** Node id prefix (default 'T') so ids do not collide with the base graph. */
  idPrefix?: string;
}

const node = (
  id: string,
  kind: AutopilotNode['kind'],
  purpose: string,
  depends_on: string[],
  acceptance_refs: string[],
  file_scope?: string[],
): AutopilotNode => ({
  id,
  kind,
  owner: kindToOwner(kind),
  purpose,
  status: 'pending',
  depends_on,
  acceptance_refs,
  evidence_refs: [],
  ac_verdicts: [],
  attempts: { fix: 0, switch: 0 },
  ...(file_scope !== undefined ? { file_scope } : {}),
});

/**
 * Build the tidy subgraph: `fileBatches.length` parallel `refactor` cleanup nodes
 * (each scoped to its batch, depending only on the implement node) → one `verify`
 * DoD-replay node depending on all of them. Splice via AutopilotStore.addNodes,
 * whose validateNodeAddition is the integrity gate.
 */
export function buildTidySubgraph(input: TidySubgraphInput): AutopilotNode[] {
  const prefix = input.idPrefix ?? 'T';
  const cleanup = input.fileBatches.map((batch, i) =>
    node(
      `${prefix}c${i + 1}`,
      'refactor',
      `Tidy (behaviour-preserving) cleanup of ${batch.join(', ')}`,
      [input.implementNodeId],
      [],
      batch,
    ),
  );
  const replay = node(
    `${prefix}replay`,
    'verify',
    'Replay the implementation DoD + fitness delta after tidy (no edits)',
    cleanup.map((n) => n.id),
    input.acceptanceIds,
  );
  return [...cleanup, replay];
}
