import type { MemoryEvent } from '../schemas/memory-event';
import { isMemoryEnabled } from './flag';
import { queryMemory } from './query';

/**
 * The automatic memory-context entry point — the surface the master switch
 * governs. Fail-open by construction: when DITTO_MEMORY is off it returns
 * `undefined`, and a caller that folds `undefined` into "inject nothing" is
 * left byte-for-byte as it would be without memory (ADR-0013 D4). `undefined`
 * (not `[]`) also means "no match" so callers have a single "nothing to inject"
 * signal. Manual `queryMemory` reads are unaffected by the switch on purpose.
 */
export function autoMemoryContext(
  events: MemoryEvent[],
  opts: { text: string },
): MemoryEvent[] | undefined {
  if (!isMemoryEnabled()) return undefined;
  const hits = queryMemory(events, opts);
  return hits.length > 0 ? hits : undefined;
}
