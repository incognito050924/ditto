import type { MemoryEvent } from '../schemas/memory-event';
import { visibleHeads } from './projection';

/**
 * Body search over memory — restricted to the SAME visible set as the
 * projection (approved heads, never secret; see projection.ts). A match is a
 * case-insensitive whole-query substring OR a shared significant token (length
 * ≥ 3), so a query naming a decision id or term finds the event carrying it.
 * Visibility is enforced BEFORE matching, so a secret/pending/superseded event
 * can never surface even when its text matches.
 */
export function queryMemory(events: MemoryEvent[], opts: { text: string }): MemoryEvent[] {
  const query = opts.text.trim().toLowerCase();
  if (query.length === 0) return [];
  const queryTokens = query.split(/\s+/).filter((t) => t.length >= 3);
  return visibleHeads(events).filter((e) => {
    const body = e.text.toLowerCase();
    if (body.includes(query)) return true;
    return queryTokens.some((t) => body.includes(t));
  });
}
