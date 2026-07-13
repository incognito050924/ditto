import { z } from 'zod';
import { acgChangeEnvelope } from './acg-common';

/**
 * ACG ImpactGraph — change-impact propagation classified by
 * node kind. Statically unresolved impact is recorded in `unresolved`, never
 * hidden. journey nodes are addressed by journey_id (a flow), not a file path.
 */

const journeyKinds = ['ui_surface', 'user_journey'] as const;

export const acgAffectedNode = z
  .object({
    kind: z.enum([
      'direct_caller',
      'transitive_caller',
      'type_contract',
      'generated_client',
      'test',
      'doc',
      'external_surface',
      'ui_surface',
      'user_journey',
    ]),
    path: z.string().min(1).optional().describe('Code location; required unless kind is a journey'),
    symbol: z.string().optional(),
    journey_id: z
      .string()
      .optional()
      .describe('JourneySpec.id; required when kind is ui_surface/user_journey (OBJ-31)'),
    reason: z.string().optional(),
    handled: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    const isJourney = (journeyKinds as readonly string[]).includes(value.kind);
    if (isJourney && !value.journey_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ui_surface/user_journey node requires journey_id',
        path: ['journey_id'],
      });
    }
    if (!isJourney && !value.path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'non-journey node requires path',
        path: ['path'],
      });
    }
  })
  .describe('One affected node; journey kinds use journey_id, others use path');

export const acgUnresolvedImpact = z
  .object({
    kind: z.enum([
      'dynamic_call',
      'reflection',
      'string_dispatch',
      'config_driven',
      'cross_repo',
      'journey_unknown',
    ]),
    path: z.string().min(1),
    reason: z.string().min(1),
  })
  .describe('Statically unresolvable impact — left as unverified risk');

export const acgImpactGraph = z
  .object({
    ...acgChangeEnvelope('acg.impact-graph.v1'),
    change_target: z.string().min(1),
    change_type: z.enum(['rename', 'signature', 'behavior', 'delete', 'add', 'move']),
    affected_nodes: z.array(acgAffectedNode).default([]),
    unresolved: z.array(acgUnresolvedImpact).default([]),
  })
  .describe('ACG ImpactGraph — affected nodes + unresolved impact');

export type AcgImpactGraph = z.infer<typeof acgImpactGraph>;
export type AcgAffectedNode = z.infer<typeof acgAffectedNode>;
