import { z } from 'zod';

export const queueItemKind = z.enum([
  'found-defect',
  'in-scope-residual',
  'unverified-ac',
]);

export type QueueItemKind = z.infer<typeof queueItemKind>;

export const queueExit = z.enum(['resolved', 'new-scope-deferral', 'escape']);

export type QueueExit = z.infer<typeof queueExit>;

/**
 * Invariant 2 + completion-as-fixpoint: an item leaves the queue only through
 * one of the three exit doors. exit undefined means still open; any value
 * outside the enum is rejected.
 */
export const queueItem = z
  .object({
    id: z.string().min(1),
    kind: queueItemKind,
    exit: queueExit.optional(),
  })
  .strict();

export type QueueItem = z.infer<typeof queueItem>;
