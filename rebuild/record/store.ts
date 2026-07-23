import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  REBUILD_RECORD_SCHEMA_VERSION,
  isTerminalStatus,
  workItemRecord,
  type WorkItemRecord,
  type WorkItemStatus,
} from '../schemas/work-item-record';
import { readJson, writeJson } from '../util/fs';
import { committedWorkItemDir } from '../util/paths';
import {
  appendEvent,
  createEvent,
  listEvents,
  type WorkItemEvent,
} from './events';
import { reduceEvents, type ReducedState } from './reduce';

/**
 * Record-tier store: hybrid of authored `record.json` (details, batched at
 * close) and `events/` (boundary transitions, appended IMMEDIATELY). The
 * folded view — record overlaid with the reduced event state — is what
 * callers read; events win over the authored snapshot.
 */

export class WorkItemExistsError extends Error {
  constructor(id: string) {
    super(`work item ${id} already exists — refusing to overwrite`);
    this.name = 'WorkItemExistsError';
  }
}

export class WorkItemNotFoundError extends Error {
  constructor(id: string) {
    super(`work item ${id} not found`);
    this.name = 'WorkItemNotFoundError';
  }
}

export class TerminalStatusError extends Error {
  constructor(id: string, status: WorkItemStatus) {
    super(
      `work item ${id} is terminal (${status}) — reopen first; terminal→terminal moves are never applied`,
    );
    this.name = 'TerminalStatusError';
  }
}

export class NotTerminalError extends Error {
  constructor(id: string, status: WorkItemStatus) {
    super(`work item ${id} is not terminal (${status}) — nothing to reopen`);
    this.name = 'NotTerminalError';
  }
}

export interface LoadedWorkItem {
  record: WorkItemRecord;
  events: WorkItemEvent[];
  reduced: ReducedState;
  /** record.json overlaid with the reduced event state (events win). */
  view: WorkItemRecord;
}

function recordPath(repoRoot: string, id: string): string {
  return join(committedWorkItemDir(repoRoot, id), 'record.json');
}

function eventsDir(repoRoot: string, id: string): string {
  return join(committedWorkItemDir(repoRoot, id), 'events');
}

function foldView(
  record: WorkItemRecord,
  events: WorkItemEvent[],
  reduced: ReducedState,
): WorkItemRecord {
  const view: WorkItemRecord = {
    ...record,
    acceptance_criteria: record.acceptance_criteria.map((criterion) => {
      const folded = reduced.verdicts[criterion.id];
      return folded
        ? { ...criterion, verdict: folded.verdict, evidence: folded.evidence }
        : criterion;
    }),
  };
  if (reduced.status !== null) view.status = reduced.status;
  if (events.some((e) => e.kind === 'status')) {
    view.closed_at = reduced.closed_at;
  }
  return view;
}

export interface CreateWorkItemInput {
  id: string;
  title: string;
  goal?: string;
}

export async function createWorkItem(
  repoRoot: string,
  input: CreateWorkItemInput,
): Promise<WorkItemRecord> {
  const path = recordPath(repoRoot, input.id);
  const exists = await stat(path).then(
    () => true,
    () => false,
  );
  if (exists) throw new WorkItemExistsError(input.id);

  const now = new Date().toISOString();
  const record: WorkItemRecord = workItemRecord.parse({
    schema_version: REBUILD_RECORD_SCHEMA_VERSION,
    id: input.id,
    title: input.title,
    ...(input.goal !== undefined ? { goal: input.goal } : {}),
    status: 'draft',
    acceptance_criteria: [],
    risks: [],
    created_at: now,
    updated_at: now,
    closed_at: null,
  });
  await writeJson(path, workItemRecord, record);
  return record;
}

export async function loadWorkItem(
  repoRoot: string,
  id: string,
): Promise<LoadedWorkItem> {
  const path = recordPath(repoRoot, id);
  const exists = await stat(path).then(
    () => true,
    () => false,
  );
  if (!exists) throw new WorkItemNotFoundError(id);

  const record = await readJson(path, workItemRecord);
  const events = await listEvents(eventsDir(repoRoot, id));
  const reduced = reduceEvents(events);
  return { record, events, reduced, view: foldView(record, events, reduced) };
}

function nextSeq(events: WorkItemEvent[]): number {
  return events.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
}

export interface TransitionInput {
  to: WorkItemStatus;
  actor: string;
}

/**
 * Record a lifecycle boundary transition IMMEDIATELY as an event. Terminal
 * guard is the single chokepoint here: a terminal item accepts no transition
 * (terminal→terminal races lose to first-terminal-wins; the only exit is
 * `reopenWorkItem`).
 */
export async function transitionWorkItem(
  repoRoot: string,
  id: string,
  input: TransitionInput,
): Promise<WorkItemEvent> {
  const { events, view } = await loadWorkItem(repoRoot, id);
  if (isTerminalStatus(view.status)) {
    throw new TerminalStatusError(id, view.status);
  }
  const now = new Date().toISOString();
  const event = createEvent({
    work_item_id: id,
    seq: nextSeq(events),
    actor: input.actor,
    ts: now,
    kind: 'status',
    payload: {
      to: input.to,
      closed_at: isTerminalStatus(input.to) ? now : null,
    },
  });
  await appendEvent(eventsDir(repoRoot, id), event);
  return event;
}

/** The one authorized terminal→non-terminal path. */
export async function reopenWorkItem(
  repoRoot: string,
  id: string,
  actor: string,
): Promise<WorkItemEvent> {
  const { events, view } = await loadWorkItem(repoRoot, id);
  if (!isTerminalStatus(view.status)) {
    throw new NotTerminalError(id, view.status);
  }
  const event = createEvent({
    work_item_id: id,
    seq: nextSeq(events),
    actor,
    ts: new Date().toISOString(),
    kind: 'status',
    payload: { to: 'in_progress', closed_at: null },
  });
  await appendEvent(eventsDir(repoRoot, id), event);
  return event;
}
