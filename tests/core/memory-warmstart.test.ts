import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDelegationPacket } from '~/core/autopilot-dispatch';
import * as memoryProject from '~/core/memory-project';
import { projectMemory } from '~/core/memory-project';
import { scanSources } from '~/core/memory-scan';
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

  test('attaches decision briefs (id + summary) so the planner can cite governing decisions', async () => {
    await seedFreshGraph(coveringGraph());
    const ctx = await warmStartMemoryContext(repo, node('planner'), workItem, { now: NOW });
    // a bare decision id is not actionable; the brief carries the node summary
    // (the Decision node's name) so the agent can cite it or abstain (ac-2).
    expect(ctx?.decision_briefs).toContainEqual({
      id: 'decision:d1',
      summary: 'use loop-side fail-open query',
    });
  });

  test('researcher is a warm-start owner too', async () => {
    await seedFreshGraph(coveringGraph());
    const ctx = await warmStartMemoryContext(repo, node('researcher'), workItem, { now: NOW });
    expect(ctx).toBeDefined();
  });

  // ac-10 (round-2 review): a bare hit count cannot tell Decision-skew from
  // semantic-layer contribution — the expansion gate needs the decomposition.
  test('ac-10: a hit records and aggregates the node_type decomposition', async () => {
    await seedFreshGraph(coveringGraph());
    await warmStartMemoryContext(repo, node('planner'), workItem, { now: NOW });
    const report = await readUsageReport(repo, workItem.id);
    const rec = report.records[0];
    expect(rec?.hit).toBe(true);
    expect(rec?.hit_node_types).toBeDefined();
    const total = Object.values(rec?.hit_node_types ?? {}).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    // the aggregated report sums per type; the covering graph relates a Decision.
    expect(report.hit_node_types.Decision ?? 0).toBeGreaterThan(0);
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

  test('disabled via master DITTO_MEMORY=off ⇒ undefined, no query/record, dispatch packet unchanged (§10-9 ①②, ac-13)', async () => {
    await seedFreshGraph(coveringGraph());
    const wi = {
      id: 'wi_warm1',
      title: 'memory graph warm-start dispatch',
      goal: 'wire warm-start into the autopilot dispatch path',
      changed_files: ['src/x.ts'],
    } as unknown as WorkItem;
    const planner = {
      id: 'N1',
      owner: 'planner',
      purpose: 'plan',
      acceptance_refs: [],
    } as unknown as AutopilotNode;
    // The exact packet the loop would build with no memory at all (the off baseline).
    const baseline = buildDelegationPacket(planner, wi, [], wi.changed_files, undefined);

    const prev = process.env.DITTO_MEMORY;
    process.env.DITTO_MEMORY = 'off';
    try {
      // ② §5 fail-open: the master switch off ⇒ warm-start returns undefined even
      // though the graph is fresh + covering (would otherwise inject).
      const ctx = await warmStartMemoryContext(repo, planner, wi, { now: NOW });
      expect(ctx).toBeUndefined();
      const report = await readUsageReport(repo, wi.id);
      expect(report.opportunities).toBe(0); // disabled short-circuit, no instrumentation
      // The packet the loop builds with the off-result is byte-for-byte the baseline.
      const offPacket = buildDelegationPacket(planner, wi, [], wi.changed_files, ctx);
      expect(offPacket).toEqual(baseline);
      // and context.memory is omitted entirely (autopilot behaves as without memory).
      expect('memory' in offPacket.context).toBe(false);
    } finally {
      // delete (not "= undefined") restores an originally-unset var to unset, not "undefined".
      // biome-ignore lint/performance/noDelete: env unset.
      if (prev === undefined) delete process.env.DITTO_MEMORY;
      else process.env.DITTO_MEMORY = prev;
    }
  });

  test('master DITTO_MEMORY=off subsumes DITTO_MEMORY_WARMSTART (single switch, §10-9 ①)', async () => {
    await seedFreshGraph(coveringGraph());
    const prevM = process.env.DITTO_MEMORY;
    const prevW = process.env.DITTO_MEMORY_WARMSTART;
    process.env.DITTO_MEMORY = 'off';
    // even with the granular flag explicitly "on", the master off wins.
    process.env.DITTO_MEMORY_WARMSTART = '1';
    try {
      const ctx = await warmStartMemoryContext(repo, node('planner'), workItem, { now: NOW });
      expect(ctx).toBeUndefined();
    } finally {
      // biome-ignore lint/performance/noDelete: env unset (restore to unset, not "undefined").
      if (prevM === undefined) delete process.env.DITTO_MEMORY;
      else process.env.DITTO_MEMORY = prevM;
      // biome-ignore lint/performance/noDelete: env unset (restore to unset, not "undefined").
      if (prevW === undefined) delete process.env.DITTO_MEMORY_WARMSTART;
      else process.env.DITTO_MEMORY_WARMSTART = prevW;
    }
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
      // biome-ignore lint/performance/noDelete: env unset (restore to unset, not "undefined").
      if (prev === undefined) delete process.env.DITTO_MEMORY_WARMSTART;
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

  // ac-5 (wi_260612503 ①): the warm-start guard must split the two axis-2 verdicts.
  // code_drift (owning-repo HEAD diverged) is a trust defect ⇒ suppress like stale.
  // code_dirty (working tree dirty) is the normal dev state ⇒ MUST still inject, or
  // memory goes inert the moment you touch a file. The detection itself is the prior
  // node's scope, so we spy memoryStatus to drive each verdict deterministically.
  function stubStatus(freshness: memoryProject.Freshness) {
    return spyOn(memoryProject, 'memoryStatus').mockResolvedValue({
      freshness,
      dirty_sources: [],
      drifted_repos: [],
      drifted_sources: [],
      pending_count: 0,
      current_set_hash: 'h',
    });
  }

  test('ac-5: code_drift ⇒ suppressed (0 injections), recorded with the label', async () => {
    await seedFreshGraph(coveringGraph());
    const spy = stubStatus('code_drift');
    try {
      const ctx = await warmStartMemoryContext(repo, node('planner'), workItem, { now: NOW });
      expect(ctx).toBeUndefined(); // 0 warm-start injections
      const report = await readUsageReport(repo, workItem.id);
      expect(report.attempts).toBe(0);
      expect(report.actionable).toBe(0);
      expect(report.records[0]?.freshness).toBe('code_drift');
    } finally {
      spy.mockRestore();
    }
  });

  test('ac-5: code_dirty ⇒ injected (1 injection), freshness label preserved (not inert)', async () => {
    await seedFreshGraph(coveringGraph());
    const spy = stubStatus('code_dirty');
    try {
      const ctx = await warmStartMemoryContext(repo, node('planner'), workItem, { now: NOW });
      expect(ctx).toBeDefined(); // 1 warm-start injection (dev working tree is dirty)
      expect(ctx?.related_nodes).toContain('sym:memory-warmstart');
      const report = await readUsageReport(repo, workItem.id);
      expect(report.actionable).toBe(1);
      // the consumer can still see the tree was dirty (label preserved, not erased).
      expect(report.records[0]?.freshness).toBe('code_dirty');
    } finally {
      spy.mockRestore();
    }
  });

  // ac-5 regression (HIGH, review-axis2): end-to-end through the REAL memoryStatus
  // priority synthesis (no stub). A stale projection on a dirty dev tree must NOT
  // be injected. Before the priority reorder, axis-2 code_dirty masked axis-1 stale
  // → the gate (which admits code_dirty) injected the stale graph as settled.
  test('ac-5: stale projection on a dirty working tree ⇒ suppressed (0 injections), recorded stale', async () => {
    function git(args: string[]): void {
      Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    }
    // Real git repo so the dirty working tree is a genuine axis-2 code_dirty signal.
    git(['init', '-q']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n', 'utf8');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init']);

    await scanSources(repo);
    await projectMemory(repo, { now: NOW });
    // Covering serving graph so coverage would pass IF freshness let us through.
    await new MemoryProjectionStore(repo).writeServing(coveringGraph());

    // Force axis-1 stale (serving_version ≠ current event-set hash)...
    const store = new MemoryProjectionStore(repo);
    const manifest = await store.readManifest();
    if (!manifest) throw new Error('manifest expected');
    await store.writeManifest({ ...manifest, serving_version: 'not-the-current-hash' });
    // ...AND dirty the working tree (the normal mid-development state).
    await writeFile(join(repo, 'a.ts'), 'export const a = 2;\n', 'utf8');

    const ctx = await warmStartMemoryContext(repo, node('planner'), workItem, { now: NOW });
    expect(ctx).toBeUndefined(); // stale wins over code_dirty ⇒ gate suppresses
    const report = await readUsageReport(repo, workItem.id);
    expect(report.opportunities).toBe(1);
    expect(report.attempts).toBe(0);
    expect(report.records[0]?.freshness).toBe('stale');
  });
});
