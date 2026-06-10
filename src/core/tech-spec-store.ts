import { join } from 'node:path';
import { type TechSpecState, techSpecState } from '~/schemas/tech-spec-state';
import { localDir } from './ditto-paths';
import { ensureDir, readJson, writeJson } from './fs';

/**
 * TechSpecStore — schema-validated read/write of
 * `.ditto/local/work-items/<id>/tech-spec-state.json`. The tech-spec driver
 * owns this path; readers go through `get` so the state invariants hold.
 */
export class TechSpecStore {
  constructor(public readonly repoRoot: string) {}

  private dir(workItemId: string): string {
    return localDir(this.repoRoot, 'work-items', workItemId);
  }

  private path(workItemId: string): string {
    return join(this.dir(workItemId), 'tech-spec-state.json');
  }

  async exists(workItemId: string): Promise<boolean> {
    return Bun.file(this.path(workItemId)).exists();
  }

  async get(workItemId: string): Promise<TechSpecState> {
    return readJson(this.path(workItemId), techSpecState);
  }

  /** Atomic, schema-validated full-replace write. */
  async write(state: TechSpecState): Promise<TechSpecState> {
    await ensureDir(this.dir(state.work_item_id));
    return writeJson(this.path(state.work_item_id), techSpecState, state);
  }
}
