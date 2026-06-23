import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CoverageFeedbackLedger,
  attributeCoverageEscape,
  recordResidual,
  recurrenceCounts,
} from '~/core/coverage-feedback';
import { CoverageStore } from '~/core/coverage-store';
import { CATEGORY_NODE_PREFIX } from '~/core/coverage-taxonomy';
import type { CoverageMap, CoverageNode } from '~/schemas/coverage';

const TS = '2026-06-23T00:00:00.000Z';

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cov-feedback-'));
  // mark it a repo root so any path helper resolves here
  await Bun.write(join(dir, '.ditto', '.keep'), '');
  return dir;
}

function node(id: string, state: CoverageNode['state']): CoverageNode {
  return {
    id,
    parent_id: 'cov-root',
    label: 'lens?',
    origin: 'seed',
    depth_weight: 1,
    state,
    children: [],
  };
}

function mapWith(workItemId: string, nodes: CoverageNode[]): CoverageMap {
  return {
    schema_version: '0.1.0',
    work_item_id: workItemId,
    root_id: 'cov-root',
    nodes: [node('cov-root', 'open'), ...nodes],
  };
}

// ac-11b outcome loop — append-only jsonl ledger that crosses work item
// boundaries so a category re-appearing across work items can be counted (ac-4).
describe('CoverageFeedbackLedger (append-only jsonl, ac-4)', () => {
  test('append then read returns the row with injected timestamp', async () => {
    const root = await freshRepo();
    try {
      const ledger = new CoverageFeedbackLedger(root);
      const entry = await ledger.append(
        {
          work_item_id: 'wi_aaaaaaaa',
          category_id: 'cov-cat-authentication',
          fault_kind: 'depth',
          evidence: 'token path X slipped past the auth sweep',
        },
        TS,
      );
      expect(entry.recorded_at).toBe(TS);
      const all = await ledger.readAll();
      expect(all).toHaveLength(1);
      expect(all[0]?.category_id).toBe('cov-cat-authentication');
      expect(all[0]?.fault_kind).toBe('depth');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reading an absent ledger returns []', async () => {
    const root = await freshRepo();
    try {
      const ledger = new CoverageFeedbackLedger(root);
      expect(await ledger.readAll()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('appends accumulate ACROSS work item boundaries, recurrence counts per category (ac-4)', async () => {
    const root = await freshRepo();
    try {
      const ledger = new CoverageFeedbackLedger(root);
      await ledger.append(
        {
          work_item_id: 'wi_aaaaaaaa',
          category_id: 'cov-cat-time-clock',
          fault_kind: 'depth',
          evidence: 'first escape',
        },
        '2026-06-23T00:00:00.000Z',
      );
      await ledger.append(
        {
          work_item_id: 'wi_bbbbbbbb',
          category_id: 'cov-cat-time-clock',
          fault_kind: 'depth',
          evidence: 'same category, different work item',
        },
        '2026-06-24T00:00:00.000Z',
      );
      await ledger.append(
        {
          work_item_id: 'wi_cccccccc',
          category_id: 'cov-cat-configuration',
          fault_kind: 'breadth',
          evidence: 'other category',
        },
        '2026-06-25T00:00:00.000Z',
      );
      const all = await ledger.readAll();
      expect(all).toHaveLength(3);
      const counts = recurrenceCounts(all);
      expect(counts.get('cov-cat-time-clock')).toBe(2);
      expect(counts.get('cov-cat-configuration')).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ac-3 (wi_26062257r) — a general followup / residual-risk row is recorded as a
// SEPARATE kind ('residual') in the same ledger, yet the far-field cost/escape
// aggregation (recurrenceCounts) excludes it while still counting depth/breadth.
describe('residual rows (ac-3, wi_26062257r)', () => {
  test('recordResidual writes a residual row visible in the ledger', async () => {
    const root = await freshRepo();
    try {
      const ledger = new CoverageFeedbackLedger(root);
      const entry = await recordResidual(
        ledger,
        {
          work_item_id: 'wi_aaaaaaaa',
          category_id: 'deployment-rollback',
          evidence: 'rollback path not exercised; follow up next sprint',
        },
        TS,
      );
      expect(entry.fault_kind).toBe('residual');
      expect(entry.recorded_at).toBe(TS);
      const all = await ledger.readAll();
      expect(all).toHaveLength(1);
      expect(all[0]?.fault_kind).toBe('residual');
      expect(all[0]?.category_id).toBe('deployment-rollback');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('recurrenceCounts EXCLUDES residual rows but still counts depth/breadth', async () => {
    const root = await freshRepo();
    try {
      const ledger = new CoverageFeedbackLedger(root);
      await ledger.append(
        {
          work_item_id: 'wi_aaaaaaaa',
          category_id: 'cov-cat-time-clock',
          fault_kind: 'depth',
          evidence: 'far-field escape',
        },
        '2026-06-23T00:00:00.000Z',
      );
      await ledger.append(
        {
          work_item_id: 'wi_bbbbbbbb',
          category_id: 'cov-cat-configuration',
          fault_kind: 'breadth',
          evidence: 'missing lens escape',
        },
        '2026-06-24T00:00:00.000Z',
      );
      // Two residual rows — one on a category that ALSO has a far-field escape,
      // proving the residual is never folded into that category's far-field count.
      await recordResidual(
        ledger,
        {
          work_item_id: 'wi_cccccccc',
          category_id: 'cov-cat-time-clock',
          evidence: 'general followup, not a sweep escape',
        },
        '2026-06-25T00:00:00.000Z',
      );
      await recordResidual(
        ledger,
        {
          work_item_id: 'wi_dddddddd',
          category_id: 'deployment-rollback',
          evidence: 'residual risk, no far-field attribution',
        },
        '2026-06-26T00:00:00.000Z',
      );

      const all = await ledger.readAll();
      expect(all).toHaveLength(4); // all four rows are kept in the ledger
      const counts = recurrenceCounts(all);
      // depth/breadth escapes counted...
      expect(counts.get('cov-cat-time-clock')).toBe(1);
      expect(counts.get('cov-cat-configuration')).toBe(1);
      // ...residual-only category never appears in far-field cost stats
      expect(counts.has('deployment-rollback')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// Structural attribution guard (ac-2) — decides depth/breadth/reject from the
// SAME coverage.json the verdict reads (gate ↔ score agree on one input).
describe('attributeCoverageEscape (structural guard, ac-2)', () => {
  test('floor category resolved (dry-closed) → accepted as depth', async () => {
    const root = await freshRepo();
    try {
      const store = new CoverageStore(root);
      const wi = 'wi_dddddddd';
      await store.writeMap(
        wi,
        mapWith(wi, [node(`${CATEGORY_NODE_PREFIX}authentication`, 'resolved')]),
      );
      const verdict = await attributeCoverageEscape(store, {
        work_item_id: wi,
        category_id: 'authentication',
        evidence: 'auth path broke after we marked it safe',
      });
      expect(verdict.accepted).toBe(true);
      expect(verdict.fault_kind).toBe('depth');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('category absent from floor AND from coverage → accepted as breadth', async () => {
    const root = await freshRepo();
    try {
      const store = new CoverageStore(root);
      const wi = 'wi_eeeeeeee';
      await store.writeMap(
        wi,
        mapWith(wi, [node(`${CATEGORY_NODE_PREFIX}authentication`, 'resolved')]),
      );
      const verdict = await attributeCoverageEscape(store, {
        work_item_id: wi,
        category_id: 'quantum-entanglement-of-clocks',
        evidence: 'a domain no floor lens covers',
      });
      expect(verdict.accepted).toBe(true);
      expect(verdict.fault_kind).toBe('breadth');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('floor category still OPEN (never swept) → rejected, not a dry-close escape', async () => {
    const root = await freshRepo();
    try {
      const store = new CoverageStore(root);
      const wi = 'wi_ffffffff';
      await store.writeMap(
        wi,
        mapWith(wi, [node(`${CATEGORY_NODE_PREFIX}authentication`, 'open')]),
      );
      const verdict = await attributeCoverageEscape(store, {
        work_item_id: wi,
        category_id: 'authentication',
        evidence: 'still open',
      });
      expect(verdict.accepted).toBe(false);
      expect(verdict.reason).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('non-floor category present in coverage and resolved-and-held → rejected (general bug, ac-2)', async () => {
    const root = await freshRepo();
    try {
      const store = new CoverageStore(root);
      const wi = 'wi_99999999';
      await store.writeMap(
        wi,
        mapWith(wi, [
          // a discovered/derived scope node that is NOT a floor category, handled normally
          { ...node('cov-derived-payment-retry', 'resolved'), origin: 'discovered' },
        ]),
      );
      const verdict = await attributeCoverageEscape(store, {
        work_item_id: wi,
        category_id: 'cov-derived-payment-retry',
        evidence: 'a normal bug the sweep already processed',
      });
      expect(verdict.accepted).toBe(false);
      expect(verdict.reason).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('cov-cat-prefixed category_id matches the floor too (depth path)', async () => {
    const root = await freshRepo();
    try {
      const store = new CoverageStore(root);
      const wi = 'wi_77777777';
      await store.writeMap(
        wi,
        mapWith(wi, [node(`${CATEGORY_NODE_PREFIX}data-integrity`, 'resolved')]),
      );
      const verdict = await attributeCoverageEscape(store, {
        work_item_id: wi,
        category_id: 'cov-cat-data-integrity',
        evidence: 'partial write slipped through',
      });
      expect(verdict.accepted).toBe(true);
      expect(verdict.fault_kind).toBe('depth');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
