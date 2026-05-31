import { join } from 'node:path';
import { type InterviewState, interviewState } from '~/schemas/interview-state';
import { ensureDir, readJson, writeJson } from './fs';

/**
 * InterviewStore — schema-validated read/write of
 * `.ditto/work-items/<id>/interview-state.json`. The deep-interview driver
 * owns this path; readers go through `get` so InterviewState invariants
 * (readiness 0..1, dimensions w/ ambiguity 0..1, etc.) hold across hops.
 */
export class InterviewStore {
  constructor(public readonly repoRoot: string) {}

  private dir(workItemId: string): string {
    return join(this.repoRoot, '.ditto', 'work-items', workItemId);
  }

  private path(workItemId: string): string {
    return join(this.dir(workItemId), 'interview-state.json');
  }

  async exists(workItemId: string): Promise<boolean> {
    return Bun.file(this.path(workItemId)).exists();
  }

  async get(workItemId: string): Promise<InterviewState> {
    return readJson(this.path(workItemId), interviewState);
  }

  /** Atomic, schema-validated full-replace write. */
  async write(state: InterviewState): Promise<InterviewState> {
    await ensureDir(this.dir(state.work_item_id));
    return writeJson(this.path(state.work_item_id), interviewState, state);
  }
}
