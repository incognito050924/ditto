import { type RetroMetricSnapshot, retroMetricSnapshot } from '~/schemas/retro-metric-snapshot';
import { localDir } from './ditto-paths';
import { atomicWriteText } from './fs';

/** Trend stats for one metric across the grounded rows (recorded_at-ordered). */
export interface MetricTrend {
  /** number of rows that GROUNDED this metric (anti-SLOP: ungrounded rows excluded). */
  n: number;
  /** value at the earliest recorded_at among grounded rows. */
  first: number;
  /** value at the latest recorded_at among grounded rows. */
  last: number;
  mean: number;
  min: number;
  max: number;
}

/**
 * Cross-WI retro-metric trend (ADR-0024 결정4 retract-condition input). Each metric
 * is present ONLY when ≥1 row grounded it — a metric no WI recorded is OMITTED, never
 * a fabricated zero (same anti-SLOP shape the ledger preserves). The reader can then
 * see whether the floor's signals move over time (e.g. coverage up, post_cost down).
 */
export interface RetroTrendSummary {
  /** total snapshot rows (one per WI). */
  work_items: number;
  /** rows whose retro found no measurable signal (carry no metric). */
  no_measurable_signal: number;
  coverage?: MetricTrend;
  unit_only_closures?: MetricTrend;
  escape_recurrence?: MetricTrend;
  post_cost?: MetricTrend;
}

/** Build a MetricTrend from recorded_at-ordered grounded values, or undefined when none. */
function metricTrend(values: number[]): MetricTrend | undefined {
  if (values.length === 0) return undefined;
  const sum = values.reduce((s, v) => s + v, 0);
  return {
    n: values.length,
    first: values[0] as number,
    last: values[values.length - 1] as number,
    mean: sum / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/**
 * Summarize the cross-WI retro-metric trend from ledger rows. Pure. Orders rows by
 * `recorded_at` (ascending) so `first`/`last` reflect chronology regardless of input
 * order, then collects each metric's grounded values; an ungrounded metric is omitted.
 */
export function summarizeRetroTrend(rows: RetroMetricSnapshot[]): RetroTrendSummary {
  const ordered = [...rows].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const grounded = (pick: (r: RetroMetricSnapshot) => number | undefined): number[] =>
    ordered.map(pick).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  const summary: RetroTrendSummary = {
    work_items: rows.length,
    no_measurable_signal: rows.filter((r) => r.metrics.no_measurable_signal === true).length,
  };
  const coverage = metricTrend(grounded((r) => r.metrics.outcome_floor?.coverage));
  const unitOnly = metricTrend(grounded((r) => r.metrics.outcome_floor?.unit_only_closures));
  const escapeRecurrence = metricTrend(grounded((r) => r.metrics.outcome_floor?.escape_recurrence));
  const postCost = metricTrend(grounded((r) => r.metrics.process_health?.post_cost));
  if (coverage) summary.coverage = coverage;
  if (unitOnly) summary.unit_only_closures = unitOnly;
  if (escapeRecurrence) summary.escape_recurrence = escapeRecurrence;
  if (postCost) summary.post_cost = postCost;
  return summary;
}

/**
 * Append-only jsonl ledger of retro measurement snapshots (ADR-0024 Decision 4
 * trend preservation). One file for the whole repo
 * (`.ditto/local/retro-metrics.jsonl`) — crossing work item boundaries is the
 * point: the trend the ADR's retract condition needs ("does the floor reduce
 * weak-planner variance?") only exists across WIs. Mirrors `CoverageFeedbackLedger`
 * (read-existing + append-one + atomic full rewrite; concurrent writers deferred).
 *
 * ONE row per work item (first-wins idempotency), mirroring the retro memory
 * absorption's stable-key idempotency: re-driving a retro node never double-appends.
 * The row copies the `RetroMetrics` shape verbatim (anti-SLOP: an absent slot means
 * ungrounded, never a fabricated zero) — the ledger preserves, it does not invent.
 */
export class RetroMetricLedger {
  constructor(public readonly repoRoot: string) {}

  private path(): string {
    return localDir(this.repoRoot, 'retro-metrics.jsonl');
  }

  /**
   * Append one snapshot. `recorded_at` is INJECTED by the caller (never read from
   * the clock here) so the ledger stays deterministic and a sandbox that blocks
   * `new Date()` cannot break recording. Idempotent per `work_item_id`: if a row
   * for this WI already exists it is returned unchanged (no second row). The row is
   * schema-validated (retroMetricSnapshot) before it is written.
   */
  async append(
    row: Omit<RetroMetricSnapshot, 'recorded_at' | 'schema_version'>,
    recordedAt: string,
  ): Promise<RetroMetricSnapshot> {
    const existing = await this.readAll();
    const prior = existing.find((r) => r.work_item_id === row.work_item_id);
    if (prior) return prior;
    const entry = retroMetricSnapshot.parse({
      ...row,
      schema_version: '0.1.0',
      recorded_at: recordedAt,
    });
    const path = this.path();
    const file = Bun.file(path);
    const text = (await file.exists()) ? await file.text() : '';
    const trimmed = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
    await atomicWriteText(path, `${trimmed}${JSON.stringify(entry)}\n`);
    return entry;
  }

  /**
   * Read every snapshot. A line that fails schema parse throws with file:line
   * context (fail-closed — a corrupt ledger is a real problem, not a silent skip).
   */
  async readAll(): Promise<RetroMetricSnapshot[]> {
    const path = this.path();
    const file = Bun.file(path);
    if (!(await file.exists())) return [];
    const text = await file.text();
    const lines = text.split('\n').filter((l) => l.length > 0);
    return lines.map((line, i) => {
      try {
        return retroMetricSnapshot.parse(JSON.parse(line));
      } catch (err) {
        throw new Error(
          `retro-metrics.jsonl:${i + 1} failed schema parse: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
}
