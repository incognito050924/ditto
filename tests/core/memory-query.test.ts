import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectMemory } from '~/core/memory-project';
import {
  MemoryNodeNotFoundError,
  MemoryProjectionAbsentError,
  auditCounts,
  explainNode,
  pullUsageLogPath,
  queryBodies,
  queryNeighbors,
  readFreshness,
  readPullUsage,
  recordPullQuery,
  runAudit,
  shortestPath,
} from '~/core/memory-query';
import {
  MemoryEventStore,
  MemoryGraphIrStore,
  MemorySourceStore,
  type ServingGraph,
} from '~/core/memory-store';
import { type MemoryEvent, memoryEvent } from '~/schemas/memory-event';
import type { MemoryEdge, MemoryGraphIr } from '~/schemas/memory-graph-ir';
import { type MemorySource, memorySource } from '~/schemas/memory-source';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-mem-query-'));
  await mkdir(join(workDir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** A small serving graph: a-IMPORTS->b, b-RELATED_TO->c, plus isolated orphan o. */
function fixtureGraph(): ServingGraph {
  return {
    projection_id: 'proj_test00001',
    generated_at: '2026-06-09T12:00:00+00:00',
    nodes: [
      { id: 'a', node_type: 'Artifact', name: 'a' },
      { id: 'b', node_type: 'Artifact', name: 'b' },
      { id: 'c', node_type: 'Symbol', name: 'c' },
      { id: 'o', node_type: 'Symbol', name: 'orphan' },
    ],
    adjacency: {
      a: [{ to: 'b', edge_type: 'IMPORTS' }],
      b: [{ to: 'c', edge_type: 'RELATED_TO' }],
    },
  };
}

describe('queryNeighbors (undirected BFS)', () => {
  test('depth 1 reaches direct neighbors (both directions)', () => {
    const r = queryNeighbors(fixtureGraph(), 'b', 1);
    expect(r.neighbors).toEqual(['a', 'c']); // incoming a, outgoing c
  });

  test('depth 2 from a reaches b then c', () => {
    expect(queryNeighbors(fixtureGraph(), 'a', 2).neighbors).toEqual(['b', 'c']);
  });

  test('orphan has no neighbors', () => {
    expect(queryNeighbors(fixtureGraph(), 'o', 2).neighbors).toEqual([]);
  });

  test('missing node throws', () => {
    expect(() => queryNeighbors(fixtureGraph(), 'zzz', 2)).toThrow(MemoryNodeNotFoundError);
  });
});

describe('shortestPath (BFS)', () => {
  test('finds the shortest path a → c', () => {
    expect(shortestPath(fixtureGraph(), 'a', 'c').path).toEqual(['a', 'b', 'c']);
  });

  test('same node is a length-1 path', () => {
    expect(shortestPath(fixtureGraph(), 'b', 'b').path).toEqual(['b']);
  });

  test('disconnected nodes yield null path', () => {
    expect(shortestPath(fixtureGraph(), 'a', 'o').path).toBeNull();
  });

  test('shortest path is chosen when a shorter one exists', () => {
    const g = fixtureGraph();
    g.adjacency.a = [
      { to: 'b', edge_type: 'IMPORTS' },
      { to: 'c', edge_type: 'RELATED_TO' }, // direct a→c shortcut
    ];
    expect(shortestPath(g, 'a', 'c').path).toEqual(['a', 'c']);
  });
});

describe('explainNode', () => {
  test('returns the node label + outgoing and incoming edges', () => {
    const r = explainNode(fixtureGraph(), 'b');
    expect(r.node).toEqual({ id: 'b', node_type: 'Artifact', name: 'b' });
    expect(r.edges).toEqual([
      { to: 'a', edge_type: 'IMPORTS', direction: 'in' },
      { to: 'c', edge_type: 'RELATED_TO', direction: 'out' },
    ]);
  });

  test('missing node throws', () => {
    expect(() => explainNode(fixtureGraph(), 'zzz')).toThrow(MemoryNodeNotFoundError);
  });
});

describe('auditCounts', () => {
  test('counts orphan / duplicate / contradiction over the graph', () => {
    const g: ServingGraph = {
      projection_id: 'proj_audit0001',
      generated_at: '2026-06-09T12:00:00+00:00',
      nodes: [
        { id: 'a', node_type: 'Artifact', name: 'a' },
        { id: 'b', node_type: 'Artifact', name: 'b' },
        { id: 'orph', node_type: 'Symbol', name: 'orph' },
      ],
      adjacency: {
        a: [
          { to: 'b', edge_type: 'IMPORTS' },
          { to: 'b', edge_type: 'IMPORTS' }, // duplicate edge
          { to: 'b', edge_type: 'CONTRADICTS' }, // contradiction
        ],
      },
    };
    const counts = auditCounts(g, ['src_dirty0001']);
    expect(counts).toEqual({ orphan: 1, stale: 1, duplicate: 1, contradiction: 1 });
  });
});

// ---- end-to-end over a projected graph ----

function ev(id: string, over: Record<string, unknown> = {}): MemoryEvent {
  return memoryEvent.parse({
    schema_version: '0.1.0',
    event_id: id,
    event_type: 'observation',
    actor: { kind: 'agent', role: 'reviewer' },
    text: 'observed',
    created_at: '2026-06-09T10:00:00+00:00',
    status: 'pending',
    sources: [],
    confidence_kind: 'EXTRACTED',
    sensitivity: 'internal',
    ...over,
  });
}

const approval = {
  status: 'approved' as const,
  approved_by: 'user',
  decided_at: '2026-06-09T11:00:00+00:00',
};

async function seedSource(id: string, hash: string): Promise<void> {
  const s: MemorySource = memorySource.parse({
    schema_version: '0.1.0',
    source_id: id,
    source_type: 'code',
    path: `src/${id}.ts`,
    content_hash: hash,
    captured_at: '2026-06-09T10:00:00+00:00',
    revision: 'r1',
  });
  await new MemorySourceStore(workDir).write(s);
}

/** Project a 2-node IR (artifact a IMPORTS artifact b) so the serving graph is non-trivial. */
async function projectFixture(): Promise<void> {
  const edge = (id: string, from: string, to: string, edge_type: MemoryEdge['edge_type']) => ({
    id,
    from,
    to,
    edge_type,
    confidence_kind: 'EXTRACTED' as const,
    confidence_score: 1,
    properties: {},
    provenance: {
      extraction_run_id: 'xrun_fixture1',
      extracted_by: 'codeql' as const,
      schema_version: '0.1.0' as const,
    },
    weight: 1,
    requires_review: false,
    used_as_evidence: false,
  });
  const ir: MemoryGraphIr = {
    schema_version: '0.1.0',
    ir_version: 'ir_fixture01',
    generated_at: '2026-06-09T09:00:00+00:00',
    extraction_run_id: 'xrun_fixture1',
    nodes: [
      {
        id: 'artifact:src/a',
        node_type: 'Artifact',
        name: 'a',
        properties: {},
        provenance: {
          extraction_run_id: 'xrun_fixture1',
          extracted_by: 'codeql',
          schema_version: '0.1.0',
        },
      },
      {
        id: 'artifact:src/b',
        node_type: 'Artifact',
        name: 'b',
        properties: {},
        provenance: {
          extraction_run_id: 'xrun_fixture1',
          extracted_by: 'codeql',
          schema_version: '0.1.0',
        },
      },
    ],
    edges: [edge('e1', 'artifact:src/a', 'artifact:src/b', 'IMPORTS')],
    hyperedges: [],
  };
  await new MemoryGraphIrStore(workDir).write(ir);
  await seedSource('src_one00001', 'a'.repeat(64));
  // Ground the approved event in the seeded source so N1's event projection
  // (Episode node + Source node + MENTIONS edge) resolves instead of leaving
  // the Episode node orphan: source → MENTIONS → episode.
  await new MemoryEventStore(workDir).append(
    ev('memevt_appr0001', { ...approval, sources: ['src_one00001'] }),
  );
  await projectMemory(workDir, { now: new Date('2026-06-09T12:00:00Z') });
}

describe('readFreshness (envelope from manifest + status)', () => {
  test('absent before any projection', async () => {
    const f = await readFreshness(workDir);
    expect(f.freshness).toBe('absent');
    expect(f.projection_id).toBe('');
    expect(f.dirty_sources).toEqual([]);
  });

  test('fresh after projection, with projection_id and generated_at', async () => {
    await projectFixture();
    const f = await readFreshness(workDir);
    expect(f.freshness).toBe('fresh');
    expect(f.projection_id).toMatch(/^proj_/);
    expect(f.generated_at).toBe('2026-06-09T12:00:00.000Z');
    expect(f.dirty_sources).toEqual([]);
  });

  test('stale + dirty_sources after the source content changes', async () => {
    await projectFixture();
    await seedSource('src_one00001', 'b'.repeat(64)); // content changed
    const f = await readFreshness(workDir);
    expect(f.freshness).toBe('stale');
    expect(f.dirty_sources).toEqual(['src_one00001']);
  });
});

describe('runAudit (append-only history)', () => {
  test('throws when no serving graph projected', async () => {
    await expect(runAudit(workDir)).rejects.toBeInstanceOf(MemoryProjectionAbsentError);
  });

  test('computes counts and appends one entry per run (time series)', async () => {
    await projectFixture();

    const first = await runAudit(workDir, { now: new Date('2026-06-09T13:00:00Z') });
    // 2 IR nodes (artifact a/b) + N1 event projection (Episode + grounding Source).
    expect(first.entry.node_count).toBe(4);
    // 1 IMPORTS (a→b) + 1 MENTIONS (source→episode).
    expect(first.entry.edge_count).toBe(2);
    expect(first.entry.counts.orphan).toBe(0);
    expect(first.history_length).toBe(1);

    const second = await runAudit(workDir, { now: new Date('2026-06-09T14:00:00Z') });
    expect(second.history_length).toBe(2); // append-only: 2 runs → 2 entries

    // history is git-tracked under dittoDir (not .ditto/local), append-only JSONL
    const logPath = join(workDir, '.ditto', 'memory', 'audit-log.jsonl');
    const lines = (await Bun.file(logPath).text()).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).audited_at).toBe('2026-06-09T13:00:00.000Z');
    expect(JSON.parse(lines[1] as string).audited_at).toBe('2026-06-09T14:00:00.000Z');
  });
});

describe('pull-query instrumentation (ac-8: actual query utterances, not prompt text)', () => {
  test('records each pull as a JSONL line readable as data', async () => {
    expect(await readPullUsage(workDir)).toEqual([]); // empty before any query

    await recordPullQuery(workDir, {
      ts: '2026-06-09T15:00:00.000Z',
      node: 'b',
      depth: 2,
      neighbor_count: 2,
      freshness: 'fresh',
    });
    await recordPullQuery(workDir, {
      ts: '2026-06-09T15:01:00.000Z',
      node: 'o',
      depth: 1,
      neighbor_count: 0,
      freshness: 'stale',
    });

    const records = await readPullUsage(workDir);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ node: 'b', neighbor_count: 2, freshness: 'fresh' });
    expect(records[1]).toMatchObject({ node: 'o', neighbor_count: 0, freshness: 'stale' });
  });

  test('telemetry lives under .ditto/local (gitignored derivative), not the SoT tier', () => {
    expect(pullUsageLogPath(workDir)).toBe(
      join(workDir, '.ditto', 'local', 'memory', 'pull-usage.jsonl'),
    );
  });
});

describe('queryBodies (body-search fallback over events, ac-2 / F2)', () => {
  test('returns event/source for a body token absent from any node id or title', async () => {
    await projectFixture();
    // The fixture event body is "observed" — no source id or node id contains it,
    // so graph traversal cannot reach it, but body search must.
    const r = await queryBodies(workDir, 'observed');
    expect(r.matches.map((m) => m.event_id)).toContain('memevt_appr0001');
    expect(r.matches.map((m) => m.source_id)).toContain('src_one00001');
    // Answer carries the freshness envelope like every other query.
    expect(r.freshness).toBe('fresh');
    expect(r.projection_id).toMatch(/^proj_/);
  });

  test('empty result when no event body matches', async () => {
    await projectFixture();
    expect((await queryBodies(workDir, 'zzznomatch')).matches).toEqual([]);
  });
});
