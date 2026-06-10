import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectMemory } from '~/core/memory-project';
import { MemoryProjectionStore, type ServingGraph } from '~/core/memory-store';
import { readUsageReport, usageLogPath, warmStartMemoryContext } from '~/core/memory-warmstart';
import type { AutopilotNode } from '~/schemas/autopilot';
import type { WorkItem } from '~/schemas/work-item';

let repo: string;
const NOW = new Date('2026-06-09T00:00:00.000Z');

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-warmstart-'));
  await mkdir(join(repo, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const workItem = {
  id: 'wi_warm1',
  title: 'memory graph warm-start dispatch',
  goal: 'wire warm-start into the autopilot dispatch path',
  changed_files: ['src/x.ts'],
} as unknown as WorkItem;

function node(owner: AutopilotNode['owner'], id = 'N1'): AutopilotNode {
  return { id, owner } as unknown as AutopilotNode;
}

/** A serving graph whose node names share tokens ("memory","graph") with the WI. */
function coveringGraph(): ServingGraph {
  return {
    projection_id: 'proj_warm0001',
    generated_at: '2026-06-09T12:00:00.000Z',
    nodes: [
      { id: 'sym:memory-warmstart', node_type: 'Symbol', name: 'memory warmstart' },
      { id: 'art:graph', node_type: 'Artifact', name: 'graph module' },
      { id: 'decision:d1', node_type: 'Decision', name: 'use loop-side fail-open query' },
      { id: 'sym:unrelated', node_type: 'Symbol', name: 'zzz totally other' },
    ],
    adjacency: {
      'sym:memory-warmstart': [{ to: 'art:graph', edge_type: 'RELATED_TO' }],
      'art:graph': [{ to: 'decision:d1', edge_type: 'RATIONALE_FOR' }],
    },
  };
}

/**
 * Make a FRESH projection manifest (no events/sources ⇒ memoryStatus=fresh), then
 * overwrite the serving graph with `graph`. memoryStatus reads only the manifest +
 * events + sources, not the serving-graph content, so freshness stays `fresh`.
 */
async function seedFreshGraph(graph: ServingGraph): Promise<void> {
  await projectMemory(repo, { now: NOW });
  await new MemoryProjectionStore(repo).writeServing(graph);
}

describe('warmStartMemoryContext (§5-1 / §10-6 #1, fail-open warm-start)', () => {
  test('injects related nodes + decisions for a planner with fresh covering graph', async () => {
    await seedFreshGraph(coveringGraph());
    const ctx = await warmStartMemoryContext(repo, node('planner'), workItem, { now: NOW });
    expect(ctx).toBeDefined();
    expect(ctx?.related_nodes).toContain('sym:memory-warmstart');
    expect(ctx?.related_nodes).toContain('art:graph');
    // decision:d1 is 2 hops from the memory root, within depth 2.
    expect(ctx?.decisions).toContain('decision:d1');
    // the unrelated node is never pulled in (no shared token, not a neighbor).
    expect(ctx?.related_nodes).not.toContain('sym:unrelated');
  });

  test('researcher is a warm-start owner too', async () => {
    await seedFreshGraph(coveringGraph());
    const ctx = await warmStartMemoryContext(repo, node('researcher'), workItem, { now: NOW });
    expect(ctx).toBeDefined();
  });

  test('non-warm-start owner (implementer) is never injected — undefined, no record', async () => {
    await seedFreshGraph(coveringGraph());
    const ctx = await warmStartMemoryContext(repo, node('implementer'), workItem, { now: NOW });
    expect(ctx).toBeUndefined();
    const report = await readUsageReport(repo, workItem.id);
    expect(report.opportunities).toBe(0); // not a measured opportunity
  });

  test('absent projection ⇒ undefined (fail-open), recorded as a missed opportunity', async () => {
    // no projection at all
    const ctx = await warmStartMemoryContext(repo, node('planner'), workItem, { now: NOW });
    expect(ctx).toBeUndefined();
    const report = await readUsageReport(repo, workItem.id);
    expect(report.opportunities).toBe(1);
    expect(report.attempts).toBe(0);
    expect(report.hits).toBe(0);
    expect(report.actionable).toBe(0);
    expect(report.records[0]?.freshness).toBe('absent');
  });

  test('stale projection ⇒ suppressed (no stale injection), recorded', async () => {
    await seedFreshGraph(coveringGraph());
    // Force the event-set hash mismatch directly ⇒ memoryStatus flips to stale.
    const store = new MemoryProjectionStore(repo);
    const manifest = await store.readManifest();
    if (!manifest) throw new Error('manifest expected');
    await store.writeManifest({ ...manifest, serving_version: 'not-the-current-hash' });
    const ctx = await warmStartMemoryContext(repo, node('planner'), workItem, { now: NOW });
    expect(ctx).toBeUndefined();
    const report = await readUsageReport(repo, workItem.id);
    expect(report.opportunities).toBe(1);
    expect(report.attempts).toBe(0);
    expect(report.records[0]?.freshness).toBe('stale');
  });

  test('no semantic coverage ⇒ suppressed even when fresh', async () => {
    await seedFreshGraph({
      projection_id: 'proj_nocov',
      generated_at: '2026-06-09T12:00:00.000Z',
      nodes: [{ id: 'sym:zzz', node_type: 'Symbol', name: 'zzz nothing related' }],
      adjacency: {},
    });
    const ctx = await warmStartMemoryContext(repo, node('planner'), workItem, { now: NOW });
    expect(ctx).toBeUndefined();
    const report = await readUsageReport(repo, workItem.id);
    expect(report.opportunities).toBe(1);
    expect(report.attempts).toBe(0); // root never found ⇒ no attempt
    expect(report.hits).toBe(0);
  });

  test('disabled via DITTO_MEMORY_WARMSTART=0 ⇒ undefined, no query/record (rollback invariant)', async () => {
    await seedFreshGraph(coveringGraph());
    const prev = process.env.DITTO_MEMORY_WARMSTART;
    process.env.DITTO_MEMORY_WARMSTART = '0';
    try {
      const ctx = await warmStartMemoryContext(repo, node('planner'), workItem, { now: NOW });
      expect(ctx).toBeUndefined();
      const report = await readUsageReport(repo, workItem.id);
      expect(report.opportunities).toBe(0);
    } finally {
      if (prev === undefined) process.env.DITTO_MEMORY_WARMSTART = undefined;
      else process.env.DITTO_MEMORY_WARMSTART = prev;
    }
  });

  test('usage report tallies the four metrics across spawns (ac-12)', async () => {
    await seedFreshGraph(coveringGraph());
    await warmStartMemoryContext(repo, node('planner', 'N1'), workItem, { now: NOW });
    await warmStartMemoryContext(repo, node('researcher', 'N2'), workItem, { now: NOW });
    const report = await readUsageReport(repo, workItem.id);
    expect(report.opportunities).toBe(2);
    expect(report.attempts).toBe(2);
    expect(report.hits).toBe(2);
    expect(report.actionable).toBe(2);
    expect(report.records).toHaveLength(2);
    // the report source is a readable JSONL under the work item's memory/ dir.
    expect(usageLogPath(repo, workItem.id)).toContain(join('work-items', workItem.id, 'memory'));
  });
});
