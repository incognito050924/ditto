import { join } from 'node:path';

import type { IntentArtifact } from '../schemas/intent-artifact';
import {
  workItemRecord,
  type WorkItemRecord,
} from '../schemas/work-item-record';
import { captureIntentLock } from '../state/intent-lock';
import { writeJson } from '../util/fs';
import { committedWorkItemDir } from '../util/paths';
import { loadWorkItem } from './store';

/**
 * Bind a formed intent to its work item's Record: root goal, criteria WITH
 * their oracles (AC↔oracle convergence lands here, not in a side file),
 * declared risks (which the completion gate consumes as residual input), and
 * the frozen AC id-set as `intent_lock`.
 *
 * One intent = one unit: an artifact binds to exactly the work item it names,
 * and a record locks at most once — re-seeding a locked record is refused,
 * never merged.
 */

export class IntentBindingMismatchError extends Error {
  constructor(id: string, boundTo: string) {
    super(
      `intent artifact is bound to ${boundTo}, not ${id} — one intent binds exactly one work item`,
    );
    this.name = 'IntentBindingMismatchError';
  }
}

export class IntentAlreadyLockedError extends Error {
  constructor(id: string) {
    super(
      `work item ${id} already carries a locked intent — re-locking is refused (one intent = one unit)`,
    );
    this.name = 'IntentAlreadyLockedError';
  }
}

export async function lockIntent(
  repoRoot: string,
  id: string,
  artifact: IntentArtifact,
): Promise<WorkItemRecord> {
  if (artifact.work_item_id !== id) {
    throw new IntentBindingMismatchError(id, artifact.work_item_id);
  }
  const { record } = await loadWorkItem(repoRoot, id);
  if (record.intent_lock !== undefined) {
    throw new IntentAlreadyLockedError(id);
  }

  const next: WorkItemRecord = workItemRecord.parse({
    ...record,
    goal: artifact.root_goal,
    acceptance_criteria: artifact.criteria.map((c) => ({
      id: c.id,
      statement: c.statement,
      verdict: 'unverified' as const,
      evidence: [],
      oracle: c.oracle,
    })),
    risks: artifact.risks,
    intent_lock: captureIntentLock(artifact.criteria.map((c) => c.id)),
    updated_at: new Date().toISOString(),
  });
  await writeJson(
    join(committedWorkItemDir(repoRoot, id), 'record.json'),
    workItemRecord,
    next,
  );
  return next;
}
