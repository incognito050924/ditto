import { z } from 'zod';
import { isoDateTime, workItemId } from './common';

export const intentMetricHop = z
  .enum(['H1', 'H2', 'H3'])
  .describe('Which intent-chain hop the drift was detected at (intentDriftGate H1/H2/H3)');

/**
 * intent-metric (measurement-infra P2) — one persisted intent-quality measurement
 * event. Today the only kind is `intent_drift`: the Stop-hook intentDriftGate
 * verdict, which is otherwise stderr-only and volatile (handoff §2). Persisting it
 * to `.ditto/local/work-items/<id>/metrics.jsonl` (root level, mirroring
 * autopilot-decisions.jsonl) lets `ditto doctor intent-quality` correlate the
 * process metric (questions asked) against the outcome metric (drift/rework).
 */
export const intentMetric = z
  .object({
    ts: isoDateTime,
    work_item_id: workItemId,
    kind: z.literal('intent_drift').describe('Discriminator; only intent_drift is defined today'),
    source: z
      .enum(['stop_hook', 'cli'])
      .describe('Where the measurement was taken (the Stop hook, or an explicit CLI run)'),
    blocking_reasons: z
      .array(z.string())
      .default([])
      .describe('Blocking drift reasons (AC id-set scope grow/shrink)'),
    advisories: z
      .array(z.string())
      .default([])
      .describe('Non-blocking drift advisories (goal/source_request string divergence)'),
    hops: z.array(intentMetricHop).default([]).describe('Distinct hops present in this event'),
  })
  .describe('One line of .ditto/local/work-items/<id>/metrics.jsonl — a persisted drift event');

export type IntentMetric = z.infer<typeof intentMetric>;
