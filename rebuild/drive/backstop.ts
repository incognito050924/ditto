import type { Backstop } from '../state/queue-state';

/**
 * Divergence gate for invariant 12 (embodied backstop). A pure, synchronous read
 * over the existing Backstop schema: it accumulates the reasons the dispatcher
 * has diverged so §5's negative backstop can route to escape. Reasons empty ⇒
 * not tripped. No schema, no async, no io.
 */
export interface BackstopDecision {
  tripped: boolean;
  reasons: string[];
}

export function evaluateBackstop(
  backstop: Backstop,
  opts: { maxNoProgressRounds: number; maxTurns?: number },
): BackstopDecision {
  const reasons: string[] = [];
  if (backstop.no_progress_rounds >= opts.maxNoProgressRounds) {
    reasons.push(
      `no_progress_rounds ${backstop.no_progress_rounds} >= limit ${opts.maxNoProgressRounds}`,
    );
  }
  if (opts.maxTurns !== undefined && backstop.turns >= opts.maxTurns) {
    reasons.push(`turns ${backstop.turns} >= limit ${opts.maxTurns}`);
  }
  const t = backstop.queue_size_trend;
  const n = t.length;
  if (n >= 3) {
    const [a, b, c] = [t[n - 3]!, t[n - 2]!, t[n - 1]!];
    // Non-decreasing across the window AND net growth end-to-end: a plateau has
    // no net growth (that is R1's job) and a shrinking trend is healthy drain.
    if (c >= b && b >= a && c > a) {
      reasons.push(`queue_size_trend non-draining: [${a}, ${b}, ${c}]`);
    }
  }
  return { tripped: reasons.length > 0, reasons };
}
