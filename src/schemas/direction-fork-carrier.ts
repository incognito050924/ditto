import { z } from 'zod';
import { schemaVersion } from './common';

/**
 * DirectionForkCarrier — the persisted inputs to `directionForkGate`
 * (`src/core/gates.ts`, wi_260707loq). Modeled on `decision-conflict-carrier.ts`:
 * a node that hit a genuine direction fork while implementing declares the
 * three-condition evidence here (work-item dir); the Stop hook reads it like every
 * other ledger (absent → inert, malformed → fail-closed) and runs the gate so a
 * VALID 3-condition fork yields (exit0, ac-2) while everything else force-continues
 * (exit2). A direction fork only STOPS the autopilot when the chosen path would
 * change the frozen purpose AND no option has a clear advantage AND the original
 * intent cannot break the tie — the three conditions below.
 *
 * PARTIAL-vs-MALFORMED contract (ac-2): a PARTIAL carrier — one whose condition is
 * absent (`present: false`) or lacks evidence (`basis: ''`) — must still PARSE, so
 * the Stop hook can name WHICH condition is missing when it force-continues. Only a
 * malformed SHAPE (a missing condition key, a wrong type) fails to parse. The
 * present/non-empty JUDGEMENT is the gate's job, not the schema's — the schema only
 * carries the declaration, exactly as decision-conflict-carrier does.
 */
export const directionForkCondition = z
  .object({
    present: z.boolean().describe('The declaring node asserts this condition holds for the fork'),
    // Intentionally NOT `.min(1)`: a partial carrier with an empty basis must PARSE
    // (so the gate can name it as the missing condition). Non-emptiness is a GATE
    // check, not a schema constraint.
    basis: z.string().describe('Evidence for the condition (empty in a partial carrier)'),
  })
  .describe('One of the three direction-fork conditions: an assertion plus its evidence');

export const directionForkCarrier = z
  .object({
    schema_version: schemaVersion,
    mode: z.enum(['interactive', 'autopilot']),
    /** The fork-point node id — the revise anchor (ac-4/ac-5 re-drive from here). */
    node_id: z.string().min(1).describe('The node at which the direction fork occurred'),
    /** The chosen path would change the work item's frozen purpose (its AC id-set). */
    purpose_change: directionForkCondition,
    /** No candidate option has a clear advantage on the frozen intent. */
    no_clear_advantage: directionForkCondition,
    /** The original intent cannot break the tie between the options. */
    intent_cannot_break_tie: directionForkCondition,
  })
  .describe('Persisted inputs to directionForkGate, written by the node that hit the fork');

export type DirectionForkCondition = z.infer<typeof directionForkCondition>;
export type DirectionForkCarrier = z.infer<typeof directionForkCarrier>;
