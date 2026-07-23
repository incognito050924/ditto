import { z } from 'zod';

/**
 * Memory event — one immutable per-entity JSON file under
 * `.ditto/memory/events/` (git-tracked SoT). "Append-only" is achieved by
 * file immutability plus `supersedes` chains: a status change is a NEW event
 * superseding the old one, never a mutation. Only approved chain heads feed
 * projections.
 */

export const memoryEventType = z
  .enum(['decision', 'observation', 'preference', 'review_outcome', 'analysis', 'correction'])
  .describe('What kind of durable fact this event records');

export const memoryEventStatus = z
  .enum(['pending', 'approved', 'rejected', 'superseded'])
  .describe('Approval lifecycle; only approved events feed projections');

export const memoryConfidenceKind = z
  .enum(['EXTRACTED', 'INFERRED', 'AMBIGUOUS'])
  .describe('Provenance strength: verbatim-extracted, inferred, or ambiguous');

export const memorySensitivity = z
  .enum(['public', 'internal', 'secret'])
  .describe('Visibility class; secret never leaves the SoT into projections');

export const memoryActor = z
  .object({
    kind: z.enum(['user', 'agent']),
    role: z.string().min(1).optional(),
  })
  .strict();

const EVENT_ID_RE = /^memevt_[a-z0-9_-]{4,}$/;
const SOURCE_ID_RE = /^src_[a-z0-9_-]{4,}$/;

export const memoryEvent = z
  .object({
    schema_version: z.string().min(1),
    event_id: z.string().regex(EVENT_ID_RE),
    event_type: memoryEventType,
    actor: memoryActor,
    text: z.string().min(1).max(4000),
    created_at: z.string().min(1),
    status: memoryEventStatus.default('pending'),
    sources: z.array(z.string().regex(SOURCE_ID_RE)).default([]),
    confidence_kind: memoryConfidenceKind.default('EXTRACTED'),
    sensitivity: memorySensitivity.default('internal'),
    approved_by: z.string().min(1).optional(),
    decided_at: z.string().min(1).optional(),
    supersedes: z.string().regex(EVENT_ID_RE).optional(),
    governs: z
      .array(z.string().min(1))
      .default([])
      .describe('Decision-only: repo-relative code paths this decision governs'),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.status === 'approved' || event.status === 'rejected') {
      if (event.approved_by === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${event.status} events require approved_by`,
        });
      }
      if (event.decided_at === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${event.status} events require decided_at`,
        });
      }
    }
    if (event.status === 'pending' && event.approved_by !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pending events must not carry approved_by',
      });
    }
    if (event.governs.length > 0 && event.event_type !== 'decision') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'governs is decision-only',
      });
    }
  })
  .describe('One immutable memory event (per-entity SoT file)');

export type MemoryEvent = z.infer<typeof memoryEvent>;
export type MemoryEventType = z.infer<typeof memoryEventType>;
export type MemoryEventStatus = z.infer<typeof memoryEventStatus>;
export type MemoryConfidenceKind = z.infer<typeof memoryConfidenceKind>;
export type MemorySensitivity = z.infer<typeof memorySensitivity>;
export type MemoryActor = z.infer<typeof memoryActor>;
