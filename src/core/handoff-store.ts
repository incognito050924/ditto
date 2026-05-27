import { join } from 'node:path';
import type { z } from 'zod';
import type { evidenceRef } from '~/schemas/common';
import { type Handoff, handoff as handoffSchema } from '~/schemas/handoff';
import type { WorkItem } from '~/schemas/work-item';
import { readJson, writeJson } from './fs';
import { WorkItemStore } from './work-item-store';

type EvidenceRef = z.infer<typeof evidenceRef>;

/**
 * Handoff artifact builder + store (M4.1). Assembles the minimal context for the
 * next session/agent to resume the SAME work item without re-deriving intent.
 * Evidence is rendered inline (summary/command/exit code), never raw artifacts.
 */
export interface HandoffBuildInput {
  workItem: WorkItem;
  fromContext: string;
  currentState: string;
  nextFirstCheck: string;
  autopilotId?: string;
  toOwner?: string;
  decisionsMade?: string[];
  evidenceRefs?: EvidenceRef[];
  failedOrUnverified?: string[];
  openThreads?: string[];
  forbiddenScopeCreep?: string[];
  artifactAvailable?: boolean;
  now?: Date;
}

export function buildHandoff(input: HandoffBuildInput): Handoff {
  return handoffSchema.parse({
    schema_version: '0.1.0',
    work_item_id: input.workItem.id,
    ...(input.autopilotId ? { autopilot_id: input.autopilotId } : {}),
    from_context: input.fromContext,
    ...(input.toOwner ? { to_owner: input.toOwner } : {}),
    original_intent: input.workItem.source_request,
    current_state: input.currentState,
    decisions_made: input.decisionsMade ?? [],
    changed_files: input.workItem.changed_files,
    evidence_refs: input.evidenceRefs ?? [],
    failed_or_unverified: input.failedOrUnverified ?? [],
    open_threads: input.openThreads ?? [],
    next_first_check: input.nextFirstCheck,
    forbidden_scope_creep: input.forbiddenScopeCreep ?? [],
    artifact_available: input.artifactAvailable ?? true,
    created_at: (input.now ?? new Date()).toISOString(),
  });
}

export class HandoffStore {
  constructor(public readonly repoRoot: string) {}

  private relativePath(workItemId: string): string {
    return `.ditto/work-items/${workItemId}/handoff.json`;
  }

  private path(workItemId: string): string {
    return join(this.repoRoot, '.ditto', 'work-items', workItemId, 'handoff.json');
  }

  async exists(workItemId: string): Promise<boolean> {
    return Bun.file(this.path(workItemId)).exists();
  }

  async get(workItemId: string): Promise<Handoff> {
    return readJson(this.path(workItemId), handoffSchema);
  }

  /** Write the handoff artifact and link it from the work item's `handoff_path`. */
  async write(h: Handoff): Promise<Handoff> {
    const written = await writeJson(this.path(h.work_item_id), handoffSchema, h);
    const items = new WorkItemStore(this.repoRoot);
    if (await items.exists(h.work_item_id)) {
      await items.update(h.work_item_id, (current) => ({
        ...current,
        handoff_path: this.relativePath(h.work_item_id),
      }));
    }
    return written;
  }
}
