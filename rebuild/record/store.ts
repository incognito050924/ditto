import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Evidence } from '../schemas/evidence';
import type { Verdict } from '../schemas/verdict';
import {
  REBUILD_RECORD_SCHEMA_VERSION,
  RE_ENTRY_STATUSES,
  isTerminalStatus,
  workItemRecord,
  type ReEntry,
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
import { assertNotLegacyRecord } from './legacy';
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

export class ParkingRequiresFinalizeError extends Error {
  constructor(id: string, status: WorkItemStatus) {
    super(
      `work item ${id} cannot transition to "${status}" directly — parking ` +
        'statuses require the finalize path, which enforces the re_entry contract',
    );
    this.name = 'ParkingRequiresFinalizeError';
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
  await assertNotLegacyRecord(path, id); // old generation: explicit refusal

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
  if ((RE_ENTRY_STATUSES as readonly string[]).includes(input.to)) {
    // park 계약 우회 차단: partial/unverified/blocked는 re_entry를 강제하는
    // finalize 경로로만 진입한다 (이벤트-only 전이로는 재진입 계약이 안 남는다)
    throw new ParkingRequiresFinalizeError(id, input.to);
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

export class UnknownCriterionError extends Error {
  constructor(id: string, criterionId: string) {
    super(`work item ${id} has no acceptance criterion "${criterionId}"`);
    this.name = 'UnknownCriterionError';
  }
}

export interface RecordVerdictInput {
  criterion_id: string;
  verdict: Verdict;
  evidence: Evidence[];
  actor: string;
}

/** Record one criterion's outcome as an immutable event (view folds it). */
export async function recordVerdict(
  repoRoot: string,
  id: string,
  input: RecordVerdictInput,
): Promise<WorkItemEvent> {
  const { record, events } = await loadWorkItem(repoRoot, id);
  const known = record.acceptance_criteria.some(
    (c) => c.id === input.criterion_id,
  );
  if (!known) throw new UnknownCriterionError(id, input.criterion_id);
  const event = createEvent({
    work_item_id: id,
    seq: nextSeq(events),
    actor: input.actor,
    ts: new Date().toISOString(),
    kind: 'verdict',
    payload: {
      criterion_id: input.criterion_id,
      verdict: input.verdict,
      evidence: input.evidence,
    },
  });
  await appendEvent(eventsDir(repoRoot, id), event);
  return event;
}

export interface CriterionInput {
  id: string;
  statement: string;
}

/**
 * Set the acceptance-criteria set. Provenance lock (goalpost may not move):
 * before the first verdict the set is a placeholder and is replaced freely;
 * from the first verdict on, criteria dropped from the proposal are KEPT and
 * marked `superseded` — never erased — and only additions land as new rows.
 */
export async function setCriteria(
  repoRoot: string,
  id: string,
  proposed: CriterionInput[],
): Promise<WorkItemRecord> {
  const { record, events } = await loadWorkItem(repoRoot, id);
  const hasVerdict = events.some((e) => e.kind === 'verdict');
  const proposedIds = new Set(proposed.map((c) => c.id));

  const fresh = (c: CriterionInput) => ({
    id: c.id,
    statement: c.statement,
    verdict: 'unverified' as const,
    evidence: [],
  });

  const nextCriteria = hasVerdict
    ? [
        ...record.acceptance_criteria.map((existing) =>
          proposedIds.has(existing.id) || existing.superseded
            ? existing
            : { ...existing, superseded: true },
        ),
        ...proposed
          .filter(
            (c) => !record.acceptance_criteria.some((e) => e.id === c.id),
          )
          .map(fresh),
      ]
    : proposed.map(fresh);

  const next: WorkItemRecord = workItemRecord.parse({
    ...record,
    acceptance_criteria: nextCriteria,
    updated_at: new Date().toISOString(),
  });
  await writeJson(recordPath(repoRoot, id), workItemRecord, next);
  return next;
}

/** Closing statuses stamp closed_at; blocked parks the item but leaves it open. */
const CLOSING_STATUSES: readonly WorkItemStatus[] = [
  'done',
  'abandoned',
  'partial',
  'unverified',
];

export interface FinalizeInput {
  status: WorkItemStatus;
  actor: string;
  re_entry?: ReEntry;
}

/**
 * Close the item: the boundary transition lands immediately as an event, and
 * the authored details (folded verdicts, re_entry, timestamps) are batched
 * into record.json in one write. The candidate record is validated BEFORE the
 * event is appended, so a schema refusal (e.g. partial without re_entry)
 * leaves both tiers untouched.
 */
export async function finalizeWorkItem(
  repoRoot: string,
  id: string,
  input: FinalizeInput,
): Promise<WorkItemRecord> {
  const { record, events, reduced, view } = await loadWorkItem(repoRoot, id);
  if (isTerminalStatus(view.status)) {
    throw new TerminalStatusError(id, view.status);
  }
  const now = new Date().toISOString();
  const closedAt = CLOSING_STATUSES.includes(input.status) ? now : null;

  const candidate: unknown = {
    ...record,
    status: input.status,
    ...(input.re_entry !== undefined ? { re_entry: input.re_entry } : {}),
    acceptance_criteria: record.acceptance_criteria.map((criterion) => {
      const folded = reduced.verdicts[criterion.id];
      return folded
        ? { ...criterion, verdict: folded.verdict, evidence: folded.evidence }
        : criterion;
    }),
    updated_at: now,
    closed_at: closedAt,
  };
  const validated = workItemRecord.parse(candidate);

  const event = createEvent({
    work_item_id: id,
    seq: nextSeq(events),
    actor: input.actor,
    ts: now,
    kind: 'status',
    payload: { to: input.status, closed_at: closedAt },
  });
  await appendEvent(eventsDir(repoRoot, id), event);
  await writeJson(recordPath(repoRoot, id), workItemRecord, validated);
  return validated;
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
