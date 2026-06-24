import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetroMetricLedger } from '~/core/retro-metric-ledger';

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
