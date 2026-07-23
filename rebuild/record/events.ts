import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { evidence } from '../schemas/evidence';
import { verdict } from '../schemas/verdict';
import {
  REBUILD_RECORD_SCHEMA_VERSION,
  workItemStatus,
} from '../schemas/work-item-record';
import { ensureDir } from '../util/fs';

/**
 * Per-event immutable log under `.ditto/work-items/<id>/events/`.
 *
 * One file per transition, named `<seq 6-pad>.<actor>.<eid 12-hex>.json`,
 * created with the exclusive `wx` flag — an existing file is NEVER rewritten,
 * which is what makes the log append-only rather than last-writer-wins.
 *
 * Two event kinds cover the state that flows through events (everything else
 * is authored directly in record.json): `status` = lifecycle boundary
 * transition (recorded immediately), `verdict` = per-criterion outcome.
 */

const statusPayload = z
  .object({
    to: workItemStatus,
    /** Set by closing transitions; reopen simply omits it (timestamp drops). */
    closed_at: z.string().min(1).nullable().optional(),
  })
  .strict();

const verdictPayload = z
  .object({
    criterion_id: z.string().min(1),
    verdict,
    evidence: z.array(evidence),
  })
  .strict();

export const workItemEvent = z.discriminatedUnion('kind', [
  z
    .object({
      schema_version: z.literal(REBUILD_RECORD_SCHEMA_VERSION),
      work_item_id: z.string().min(1),
      seq: z.number().int().min(1),
      actor: z.string().min(1),
      event_id: z.string().regex(/^[0-9a-f]{64}$/),
      ts: z.string().min(1),
      kind: z.literal('status'),
      payload: statusPayload,
    })
    .strict(),
  z
    .object({
      schema_version: z.literal(REBUILD_RECORD_SCHEMA_VERSION),
      work_item_id: z.string().min(1),
      seq: z.number().int().min(1),
      actor: z.string().min(1),
      event_id: z.string().regex(/^[0-9a-f]{64}$/),
      ts: z.string().min(1),
      kind: z.literal('verdict'),
      payload: verdictPayload,
    })
    .strict(),
]);
export type WorkItemEvent = z.infer<typeof workItemEvent>;

export type WorkItemEventInput = Omit<
  WorkItemEvent,
  'schema_version' | 'event_id'
>;

/**
 * Derive the event from its logical content. `event_id` hashes the identity
 * fields but NOT `ts`, so retrying the same logical transition yields the same
 * id (dedupe-friendly), while wall-clock jitter never forks identity.
 */
export function createEvent(input: WorkItemEventInput): WorkItemEvent {
  const identity = JSON.stringify([
    input.work_item_id,
    input.seq,
    input.actor,
    input.kind,
    input.payload,
  ]);
  const event_id = createHash('sha256').update(identity).digest('hex');
  return workItemEvent.parse({
    ...input,
    schema_version: REBUILD_RECORD_SCHEMA_VERSION,
    event_id,
  });
}

/** Filename-safe actor: lowercase, runs of anything else collapse to `-`. */
function safeActor(actor: string): string {
  const cleaned = actor
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'actor';
}

export function eventFileName(event: WorkItemEvent): string {
  const seq = String(event.seq).padStart(6, '0');
  return `${seq}.${safeActor(event.actor)}.${event.event_id.slice(0, 12)}.json`;
}

/**
 * Append one event as its own file. Exclusive create (`wx`): if the same
 * logical event already exists this throws and the on-disk file is untouched.
 */
export async function appendEvent(
  eventsDir: string,
  event: WorkItemEvent,
): Promise<void> {
  const validated = workItemEvent.parse(event);
  await ensureDir(eventsDir);
  await writeFile(
    join(eventsDir, eventFileName(validated)),
    `${JSON.stringify(validated, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
}

/** Read every persisted event, schema-validated. Missing dir = empty log. */
export async function listEvents(eventsDir: string): Promise<WorkItemEvent[]> {
  let files: string[];
  try {
    files = await readdir(eventsDir);
  } catch {
    return [];
  }
  const events: WorkItemEvent[] = [];
  for (const file of files.filter((f) => f.endsWith('.json')).sort()) {
    const raw: unknown = JSON.parse(await readFile(join(eventsDir, file), 'utf8'));
    events.push(workItemEvent.parse(raw));
  }
  return events;
}
