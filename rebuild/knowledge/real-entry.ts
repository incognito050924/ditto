import { assertRebuildRecorderEnabled } from '../record/flip-gate';
import { createAdrSkeleton } from './adr-authoring';
import { syncKnowledgeProjection, type KnowledgeSyncResult } from './projection-sync';

/**
 * REAL-write entry points for the knowledge surface. During coexistence the
 * old src is the sole real recorder; the pure functions (createAdrSkeleton,
 * syncKnowledgeProjection) are exercised through fixture contract tests only.
 * Any real (non-fixture) write must come through here, which fail-closes on
 * the ONE committed flip switch (.ditto/recorder.json) — the same gate the
 * record store's real path uses. Read-only drift checks are ungated.
 */

/** Gated adr-new against the real repo. */
export async function realCreateAdrSkeleton(opts: {
  repoRoot: string;
  slug: string;
  now?: Date;
}): Promise<{ id: string; path: string }> {
  await assertRebuildRecorderEnabled(opts.repoRoot);
  return createAdrSkeleton(opts);
}

/** Gated CLAUDE.md projection write against the real repo. */
export async function realSyncKnowledgeProjection(
  repoRoot: string,
): Promise<KnowledgeSyncResult> {
  await assertRebuildRecorderEnabled(repoRoot);
  return syncKnowledgeProjection(repoRoot);
}
