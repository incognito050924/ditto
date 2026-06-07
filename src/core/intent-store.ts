import { join } from 'node:path';
import { type IntentContract, intentContract } from '~/schemas/intent';
import { localDir } from './ditto-paths';
import { ensureDir, readJson, writeJson } from './fs';

/**
 * IntentStore — schema-validated read/write of `.ditto/local/work-items/<id>/intent.json`.
 * Owned by deep-interview finalize and the bootstrap CLI; everywhere else just
 * reads through `get` so the IntentContract invariants(work_item_id alignment,
 * acceptance_criteria.min(1)) are enforced before any downstream use.
 */
export class IntentStore {
  constructor(public readonly repoRoot: string) {}

  private dir(workItemId: string): string {
    return localDir(this.repoRoot, 'work-items', workItemId);
  }

  private path(workItemId: string): string {
    return join(this.dir(workItemId), 'intent.json');
  }

  async exists(workItemId: string): Promise<boolean> {
    return Bun.file(this.path(workItemId)).exists();
  }

  async get(workItemId: string): Promise<IntentContract> {
    return readJson(this.path(workItemId), intentContract);
  }

  /** Atomic, schema-validated full-replace write. */
  async write(intent: IntentContract): Promise<IntentContract> {
    await ensureDir(this.dir(intent.work_item_id));
    return writeJson(this.path(intent.work_item_id), intentContract, intent);
  }
}
