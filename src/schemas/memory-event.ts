import { z } from 'zod';
import { isoDateTime, schemaVersion } from './common';
import { memoryConfidenceKind } from './memory-graph-ir';
import { memorySensitivity, memorySourceId } from './memory-source';

export const memoryEventId = z
  .string()
  .regex(
    /^memevt_[a-z0-9_-]{4,}$/,
    'memory event id must start with memevt_ followed by 4+ lowercase alphanumerics, underscore, or hyphen',
  )
  .describe('Stable identifier for one append-only memory event');

export const memoryEventType = z
  .enum(['decision', 'observation', 'preference', 'review_outcome', 'analysis', 'correction'])
  .describe('What kind of memory this event records');

export const memoryEventStatus = z
  .enum(['pending', 'approved', 'rejected', 'superseded'])
  .describe('Review lifecycle; only approved events feed projections (report §10)');

export const memoryActor = z
  .object({
    kind: z.enum(['user', 'agent']),
    role: z.string().min(1).optional().describe('agent role when kind=agent, e.g. reviewer'),
  })
  .describe('Who authored the event');

export const memoryEvent = z
  .object({
    schema_version: schemaVersion,
    event_id: memoryEventId,
    event_type: memoryEventType,
    actor: memoryActor,
    text: z.string().min(1).max(4000),
    created_at: isoDateTime,
    status: memoryEventStatus.default('pending'),
    sources: z.array(memorySourceId).default([]).describe('source ids grounding this event'),
    confidence_kind: memoryConfidenceKind.default('EXTRACTED'),
    sensitivity: memorySensitivity.default('internal'),
    approved_by: z.string().min(1).optional(),
    decided_at: isoDateTime.optional(),
    supersedes: memoryEventId.optional(),
  })
  .superRefine((event, ctx) => {
    // Approval invariant: approved/rejected events must record who and when.
    if ((event.status === 'approved' || event.status === 'rejected') && !event.approved_by) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'approved/rejected events require approved_by',
        path: ['approved_by'],
      });
    }
    if ((event.status === 'approved' || event.status === 'rejected') && !event.decided_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'approved/rejected events require decided_at',
        path: ['decided_at'],
      });
    }
    // Pending events are unreviewed by definition.
    if (event.status === 'pending' && event.approved_by) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pending events must not carry approved_by',
        path: ['approved_by'],
      });
    }
  })
  .describe(
    'Append-only memory event — SoT for knowledge not reconstructable from raw source (report §3.2)',
  );

export type MemoryEvent = z.infer<typeof memoryEvent>;
