import { z } from 'zod';
import { schemaVersion, workItemId } from './common';

// Pre-mortem coverage engine — dynamic-growth scope tree (premortem-coverage-contract §3.1·§3.2).
// The tree grows append-only as interrogation proceeds; origin records how each node entered
// (seed = initial decomposition, derived = from an answer, discovered = completeness-critic).

export const coverageOrigin = z
  .enum(['seed', 'derived', 'discovered'])
  .describe('How a coverage node entered the tree (§3.2)');

export const coverageNodeState = z
  .enum(['open', 'resolved', 'user_owned', 'out_of_scope'])
  .describe('Closure state of a coverage node (§3.3)');

export const coverageNode = z
  .object({
    id: z.string().min(1),
    parent_id: z.string().min(1).nullable().describe('Parent node id; null for the root'),
    label: z.string().min(1),
    origin: coverageOrigin,
    depth_weight: z.number().describe('Estimated needed depth (§4.4)'),
    state: coverageNodeState,
    children: z
      .array(z.string().min(1))
      .default([])
      .describe('Child node ids (flat array + parent_id represents the tree/DAG)'),
    close_reason: z
      .string()
      .optional()
      .describe(
        'Recorded justification when the node is closed in a non-resolved state — a skip/deferral must be justified, never silent (§8-2, ac-2)',
      ),
  })
  .describe('One node in the coverage scope tree (§3.1)');

export const coverageTier = z
  .enum(['light', 'standard', 'full'])
  .describe('Sweep intensity tier — scales sweepAngles and termination depth K (§8-4, ac-4)');

export const coverageMap = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    root_id: z.string().min(1).describe('Id of the root node (user original intent)'),
    nodes: z.array(coverageNode).default([]),
    intensity: coverageTier
      .optional()
      .describe(
        'Entry intensity override (ac-4) persisted on the first seed so the tier and termination depth K stay consistent across every round without the caller re-passing it (§8-4)',
      ),
  })
  .describe('Coverage map sidecar (coverage.json) — additive dynamic-growth scope tree (§9)');

export type CoverageNode = z.infer<typeof coverageNode>;
export type CoverageMap = z.infer<typeof coverageMap>;

// Plan-stage coverage-round payload (§4·§5 wiring) — the structural signals the
// fresh fan-out hands back to the deterministic Manager via `coverage-round`. The
// Manager appends children (append-only), steps the dry counter, and — on
// `close_as` — runs the six §2 axis mechanisms + false-green gate. The
// natural-language `label` is carried but never interpreted by code (§4.1).
const coverageChildInput = z.object({
  id: z.string().min(1),
  parent_id: z.string().min(1),
  label: z.string().min(1),
  origin: z.enum(['derived', 'discovered']),
  depth_weight: z.number(),
});

export const coverageRoundPayload = z
  .object({
    node_id: z.string().min(1),
    derived_nodes: z.array(coverageChildInput).default([]),
    discovered_nodes: z.array(coverageChildInput).default([]),
    admissibleBranchesAdded: z.number().int().nonnegative(),
    close_as: z.enum(['resolved', 'user_owned', 'out_of_scope']).optional(),
    close_reason: z
      .string()
      .optional()
      .describe(
        'Justification for a skip/deferral close (out_of_scope/user_owned) — required to skip a seeded category, recorded on the node (§8-2, ac-2)',
      ),
    axis_signals: z
      .object({
        neutrality: z
          .object({
            opponent_ran: z.boolean(),
            verdict: z.enum(['accept', 'revise', 'reject', 'blocked']),
          })
          .optional(),
        balance: z
          .object({
            achievedDepth: z.number(),
            open_required_sections: z.number(),
            conflicting: z.number(),
            assumption_ratio: z.number(),
          })
          .optional(),
        priority: z
          .object({
            userPriority: z.enum(['high', 'normal', 'low']),
            achievedDepth: z.number(),
          })
          .optional(),
        temporalBaseline: z.array(z.string()).optional(),
        temporalCurrent: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .describe('One coverage interrogation round handed back to the deterministic Manager (§5)');

export type CoverageRoundPayload = z.infer<typeof coverageRoundPayload>;

// Tier-② project taxonomy config (ac-10) — `.ditto/coverage-taxonomy.json`, git-tracked
// (team-shared, NOT the per-developer tier-③ `.ditto/local/config.json`). DITTO ships a
// good floor; a project enables/disables/adds categories here to reflect its own auth
// model / domain. Absent or malformed → the code floor (fail-open). Each added category
// is a probing-QUESTION lens (ac-1), not a bare noun.
export const coverageTaxonomyConfig = z
  .object({
    disabled: z
      .array(z.string().min(1))
      .optional()
      .describe('Floor category ids to turn off for this project (ac-10)'),
    added: z
      .array(
        z.object({
          id: z.string().min(1),
          lens: z.string().min(1).describe('Probing-question lens the sweep answers (ac-1)'),
        }),
      )
      .optional()
      .describe(
        'Project-added categories (id + probing-question lens); id collision overrides a floor lens',
      ),
  })
  .describe(
    'Tier-② project far-field taxonomy config (.ditto/coverage-taxonomy.json, git-tracked) — ac-10',
  );

export type CoverageTaxonomyConfig = z.infer<typeof coverageTaxonomyConfig>;
