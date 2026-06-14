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
  })
  .describe('One node in the coverage scope tree (§3.1)');

export const coverageMap = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    root_id: z.string().min(1).describe('Id of the root node (user original intent)'),
    nodes: z.array(coverageNode).default([]),
  })
  .describe('Coverage map sidecar (coverage.json) — additive dynamic-growth scope tree (§9)');

export type CoverageNode = z.infer<typeof coverageNode>;
export type CoverageMap = z.infer<typeof coverageMap>;
