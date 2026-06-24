import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetroMetricLedger, summarizeRetroTrend } from '~/core/retro-metric-ledger';
import type { RetroMetricSnapshot } from '~/schemas/retro-metric-snapshot';

// ADR-0024 Decision 4 trend preservation: a cross-WI append-only ledger of retro
// measurements. The metrics are ephemeral (a past WI's coverage can't be rebuilt),
// so the ledger must capture one row per WI at retro time, idempotently.

let repo: string;
const NOW = '2026-06-24T00:00:00.000Z';

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-retro-ledger-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('RetroMetricLedger', () => {
  test('append + readAll round-trips a grounded snapshot', async () => {
    const ledger = new RetroMetricLedger(repo);
    await ledger.append(
      {
        work_item_id: 'wi_a',
        metrics: { outcome_floor: { coverage: 0.5, unit_only_closures: 1 } },
      },
      NOW,
    );
    const rows = await ledger.readAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.work_item_id).toBe('wi_a');
    expect(rows[0]?.recorded_at).toBe(NOW);
    expect(rows[0]?.metrics.outcome_floor?.coverage).toBe(0.5);
    expect(rows[0]?.metrics.outcome_floor?.unit_only_closures).toBe(1);
  });

  test('idempotent per work item — re-driving the same WI does not double-append', async () => {
    const ledger = new RetroMetricLedger(repo);
    await ledger.append(
      { work_item_id: 'wi_a', metrics: { process_health: { post_cost: 3 } } },
      NOW,
    );
    await ledger.append(
      { work_item_id: 'wi_a', metrics: { process_health: { post_cost: 9 } } },
      '2026-06-25T00:00:00.000Z',
    );
    const rows = await ledger.readAll();
    expect(rows).toHaveLength(1);
    // first-wins: the original row is preserved (matches retro memory absorption idempotency).
    expect(rows[0]?.metrics.process_health?.post_cost).toBe(3);
    expect(rows[0]?.recorded_at).toBe(NOW);
  });

  test('accumulates one row per distinct work item (the cross-WI trend)', async () => {
    const ledger = new RetroMetricLedger(repo);
    await ledger.append({ work_item_id: 'wi_a', metrics: { outcome_floor: { coverage: 1 } } }, NOW);
    await ledger.append(
      { work_item_id: 'wi_b', metrics: { outcome_floor: { coverage: 0.5 } } },
      NOW,
    );
    const rows = await ledger.readAll();
    expect(rows.map((r) => r.work_item_id)).toEqual(['wi_a', 'wi_b']);
    expect(rows.map((r) => r.metrics.outcome_floor?.coverage)).toEqual([1, 0.5]);
  });

  test('no_measurable_signal snapshot is preserved verbatim', async () => {
    const ledger = new RetroMetricLedger(repo);
    await ledger.append({ work_item_id: 'wi_a', metrics: { no_measurable_signal: true } }, NOW);
    const rows = await ledger.readAll();
    expect(rows[0]?.metrics.no_measurable_signal).toBe(true);
    expect(rows[0]?.metrics.outcome_floor).toBeUndefined();
  });
});

// ADR-0024 결정4 후속: the ledger persists, but nothing READ the trend — the
// retract condition ("does the floor reduce weak-planner variance?") needs the
// cross-WI trend surfaced. summarizeRetroTrend is the pure consumer.
describe('summarizeRetroTrend', () => {
  function snap(
    id: string,
    recordedAt: string,
    metrics: RetroMetricSnapshot['metrics'],
  ): RetroMetricSnapshot {
    return { schema_version: '0.1.0', work_item_id: id, recorded_at: recordedAt, metrics };
  }

  test('per-metric n/first/last/mean/min/max over grounded rows', () => {
    const rows: RetroMetricSnapshot[] = [
      snap('wi_a', '2026-06-01T00:00:00.000Z', {
        outcome_floor: { coverage: 0.5, unit_only_closures: 2 },
        process_health: { post_cost: 6 },
      }),
      snap('wi_b', '2026-06-02T00:00:00.000Z', {
        outcome_floor: { coverage: 0.8, unit_only_closures: 0 },
        process_health: { post_cost: 3 },
      }),
      snap('wi_c', '2026-06-03T00:00:00.000Z', {
        outcome_floor: { coverage: 0.2, unit_only_closures: 1 },
        process_health: { post_cost: 0 },
      }),
    ];
    const t = summarizeRetroTrend(rows);
    expect(t.work_items).toBe(3);
    expect(t.no_measurable_signal).toBe(0);
    // coverage: values [0.5, 0.8, 0.2] in recorded_at order
    expect(t.coverage).toEqual({ n: 3, first: 0.5, last: 0.2, mean: 0.5, min: 0.2, max: 0.8 });
    expect(t.unit_only_closures).toEqual({ n: 3, first: 2, last: 1, mean: 1, min: 0, max: 2 });
    expect(t.post_cost).toEqual({ n: 3, first: 6, last: 0, mean: 3, min: 0, max: 6 });
  });

  test('a metric grounded in NO row is OMITTED (anti-SLOP — never a fabricated zero)', () => {
    const rows: RetroMetricSnapshot[] = [snap('wi_a', NOW, { outcome_floor: { coverage: 1 } })];
    const t = summarizeRetroTrend(rows);
    expect(t.coverage).toBeDefined();
    // no row carried escape_recurrence / unit_only_closures / post_cost → omitted.
    expect(t.escape_recurrence).toBeUndefined();
    expect(t.unit_only_closures).toBeUndefined();
    expect(t.post_cost).toBeUndefined();
  });

  test('first/last follow recorded_at order, not array order', () => {
    // Out-of-order input: the LATER timestamp appears first in the array.
    const rows: RetroMetricSnapshot[] = [
      snap('wi_late', '2026-06-10T00:00:00.000Z', { outcome_floor: { coverage: 0.9 } }),
      snap('wi_early', '2026-06-01T00:00:00.000Z', { outcome_floor: { coverage: 0.1 } }),
    ];
    const t = summarizeRetroTrend(rows);
    expect(t.coverage?.first).toBe(0.1); // earliest recorded_at
    expect(t.coverage?.last).toBe(0.9); // latest recorded_at
  });

  test('no_measurable_signal rows are counted but contribute to no metric', () => {
    const rows: RetroMetricSnapshot[] = [
      snap('wi_a', NOW, { no_measurable_signal: true }),
      snap('wi_b', '2026-06-25T00:00:00.000Z', { outcome_floor: { coverage: 0.5 } }),
    ];
    const t = summarizeRetroTrend(rows);
    expect(t.work_items).toBe(2);
    expect(t.no_measurable_signal).toBe(1);
    expect(t.coverage).toEqual({ n: 1, first: 0.5, last: 0.5, mean: 0.5, min: 0.5, max: 0.5 });
  });

  test('empty ledger → zero work items, every metric omitted', () => {
    const t = summarizeRetroTrend([]);
    expect(t.work_items).toBe(0);
    expect(t.no_measurable_signal).toBe(0);
    expect(t.coverage).toBeUndefined();
    expect(t.post_cost).toBeUndefined();
  });
});
