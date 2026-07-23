import { rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { isTerminalStatus } from '../schemas/work-item-record';
import { ensureDir } from '../util/fs';
import { committedWorkItemDir, dittoDir } from '../util/paths';
import { loadWorkItem, NotTerminalError } from './store';

/**
 * Manual cold-storage archiving: MOVE (never delete) a closed work item's
 * whole Record dir to `.ditto/archive/<label>/<id>/`. Only terminal items
 * qualify; legacy records refuse upstream (loadWorkItem's generation guard —
 * the old src owns heritage); git history is never rewritten, this is a plain
 * working-tree move the user commits like any change.
 */

export class ArchiveTargetExistsError extends Error {
  constructor(target: string) {
    super(`archive target already exists: ${target} — refusing to clobber`);
    this.name = 'ArchiveTargetExistsError';
  }
}

export async function archiveWorkItem(
  repoRoot: string,
  id: string,
  label: string,
): Promise<string> {
  const { view } = await loadWorkItem(repoRoot, id); // legacy → explicit refusal
  if (!isTerminalStatus(view.status)) {
    throw new NotTerminalError(id, view.status);
  }
  const target = join(dittoDir(repoRoot), 'archive', label, id);
  const exists = await stat(target).then(
    () => true,
    () => false,
  );
  if (exists) throw new ArchiveTargetExistsError(target);
  await ensureDir(dirname(target));
  await rename(committedWorkItemDir(repoRoot, id), target);
  return target;
}
