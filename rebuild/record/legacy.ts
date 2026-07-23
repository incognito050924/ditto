import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import {
  REBUILD_RECORD_SCHEMA_VERSION,
  workItemRecord,
} from '../schemas/work-item-record';
import { dittoDir } from '../util/paths';
import { listEvents } from './events';
import { reduceEvents } from './reduce';

/**
 * Old-generation records are READ-ONLY heritage: never rewritten, never
 * migrated, never reopened. The rebuild store refuses to touch them with an
 * explicit error (not an incidental parse failure), and the backlog view
 * merges both generations leniently — an old record with retired verdict
 * values or dropped fields still lists.
 */

export class LegacyRecordReadOnlyError extends Error {
  constructor(id: string) {
    super(
      `work item ${id} is an old-generation record — read-only heritage; ` +
        'rewrite/reopen is refused (backlog lists it, the old src owns it)',
    );
    this.name = 'LegacyRecordReadOnlyError';
  }
}

/** Lenient summary shape for old-generation records — everything optional but id. */
const legacySummary = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    status: z.string().optional(),
    closed_at: z.string().nullable().optional(),
  })
  .passthrough();

export function isRebuildGeneration(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { schema_version?: unknown }).schema_version ===
      REBUILD_RECORD_SCHEMA_VERSION
  );
}

async function readRawRecord(
  recordPath: string,
): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(recordPath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null; // exists but unparseable — caller degrades, never throws
  }
}

/** Guard for mutating/reading paths of the NEW store: legacy → explicit refusal. */
export async function assertNotLegacyRecord(
  recordPath: string,
  id: string,
): Promise<void> {
  const raw = await readRawRecord(recordPath);
  if (raw === undefined) return; // absent — not-found handling is the caller's
  if (!isRebuildGeneration(raw)) throw new LegacyRecordReadOnlyError(id);
}

export interface BacklogEntry {
  id: string;
  title: string;
  /** Plain string, not the new enum — old statuses pass through untouched. */
  status: string;
  closed_at: string | null;
  generation: 'rebuild' | 'legacy';
}

/**
 * The two-generation combined backlog view. Rebuild entries fold their event
 * log (events win over the authored snapshot); legacy entries are summarized
 * leniently, degrading to an id-only row rather than failing the whole view.
 */
export async function listBacklog(repoRoot: string): Promise<BacklogEntry[]> {
  const workItemsDir = join(dittoDir(repoRoot), 'work-items');
  let ids: string[];
  try {
    ids = (await readdir(workItemsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const entries: BacklogEntry[] = [];
  for (const id of ids.sort()) {
    const raw = await readRawRecord(join(workItemsDir, id, 'record.json'));
    if (raw === undefined) continue; // no record.json — not a work item dir

    if (isRebuildGeneration(raw)) {
      const parsed = workItemRecord.safeParse(raw);
      if (parsed.success) {
        const events = await listEvents(join(workItemsDir, id, 'events'));
        const reduced = reduceEvents(events);
        entries.push({
          id: parsed.data.id,
          title: parsed.data.title,
          status: reduced.status ?? parsed.data.status,
          closed_at: events.some((e) => e.kind === 'status')
            ? reduced.closed_at
            : parsed.data.closed_at,
          generation: 'rebuild',
        });
        continue;
      }
      // fall through: claims the new version but does not parse — degrade
    }

    const summary = legacySummary.safeParse(raw);
    if (summary.success) {
      entries.push({
        id: summary.data.id,
        title: summary.data.title ?? summary.data.id,
        status: summary.data.status ?? 'unknown',
        closed_at: summary.data.closed_at ?? null,
        generation: 'legacy',
      });
    } else {
      entries.push({
        id,
        title: id,
        status: 'unknown',
        closed_at: null,
        generation: 'legacy',
      });
    }
  }
  return entries;
}
