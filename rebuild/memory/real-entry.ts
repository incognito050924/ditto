import { assertRebuildRecorderEnabled } from '../record/flip-gate';
import type { MemoryEvent } from '../schemas/memory-event';
import type { MemorySource } from '../schemas/memory-source';
import { appendEvent, writeSource } from './store';

/**
 * REAL-write entry points for the memory SoT. During coexistence the old src is
 * the sole real recorder; the store's append/write functions are exercised
 * through fixture contract tests only. Any real (non-fixture) SoT write must
 * come through here, which fail-closes on the ONE committed flip switch
 * (.ditto/recorder.json) — the same gate the knowledge and record surfaces use.
 * Read-only paths (loadEvents, projectMemory, queryMemory, detectFreshness) are
 * ungated: the switch governs writes, not reads.
 */

export async function realAppendEvent(repoRoot: string, event: MemoryEvent): Promise<void> {
  await assertRebuildRecorderEnabled(repoRoot);
  await appendEvent(repoRoot, event);
}

export async function realWriteSource(repoRoot: string, source: MemorySource): Promise<void> {
  await assertRebuildRecorderEnabled(repoRoot);
  await writeSource(repoRoot, source);
}
