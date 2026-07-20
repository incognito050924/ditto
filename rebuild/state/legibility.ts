import type { QueueState } from './queue-state';

/**
 * §5 state legibility — the cheap pure read that answers the three mission
 * questions at a glance: 어디까지 왔나 (howFar) / 정말 일단락됐나 (settled) /
 * 잊혔나 (forgotten). No io, no schema, deterministic.
 */
export interface Legibility {
  howFar: {
    resolved: number;
    deferred: number;
    escaped: number;
    open: number;
    total: number;
  };
  settled: boolean;
  forgotten: string[];
  summary: string;
}

export function readLegibility(state: QueueState): Legibility {
  const resolved = state.items.filter((i) => i.exit === 'resolved').length;
  const deferred = state.items.filter(
    (i) => i.exit === 'new-scope-deferral',
  ).length;
  const escaped = state.items.filter((i) => i.exit === 'escape').length;
  const forgotten = state.items
    .filter((i) => i.exit === null)
    .map((i) => i.id);
  const open = forgotten.length;
  const total = state.items.length;
  const settled = open === 0;
  const summary =
    `${resolved}/${total} resolved, ${deferred} deferred, ` +
    `${escaped} escaped, ${open} open — ` +
    (settled ? 'SETTLED' : `NOT settled (open: ${forgotten.join(',')})`);
  return {
    howFar: { resolved, deferred, escaped, open, total },
    settled,
    forgotten,
    summary,
  };
}
