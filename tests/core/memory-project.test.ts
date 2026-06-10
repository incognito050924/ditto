import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryEventAlreadyDecidedError,
  MemoryEventNotPendingError,
  MemorySelfApprovalError,
  approveEvent,
  buildServingGraph,
  memoryStatus,
  projectEventNodes,
  projectMemory,
  proposeEvent,
} from '~/core/memory-project';
import { queryNeighbors } from '~/core/memory-query';
import { reduceEvents } from '~/core/memory-reduce';
import { MemoryEventStore, MemoryGraphIrStore, MemorySourceStore } from '~/core/memory-store';
import { type MemoryEvent, memoryEvent } from '~/schemas/memory-event';
import type { MemoryEdge, MemoryGraphIr, MemoryNode } from '~/schemas/memory-graph-ir';
import { type MemorySource, memorySource } from '~/schemas/memory-source';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-mem-proj-'));
  await mkdir(join(workDir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function ev(id: string, over: Record<string, unknown> = {}): MemoryEvent {
  return memoryEvent.parse({
    schema_version: '0.1.0',
    event_id: id,
    event_type: 'observation',
    actor: { kind: 'agent', role: 'reviewer' },
    text: 'observed something',
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

describe('reduceEvents (supersession + approval filter)', () => {
  test('emits only approved heads; pending and superseded are excluded', () => {
    const events = [
      ev('memevt_pend0001'), // pending → excluded
      ev('memevt_old00001'), // superseded below → excluded
      ev('memevt_new00001', { ...approval, supersedes: 'memevt_old00001' }), // approved head
      ev('memevt_appr0002', { ...approval }), // standalone approved head
    ];
    const { approvedHeads } = reduceEvents(events);
    expect(approvedHeads.map((e) => e.event_id)).toEqual(['memevt_appr0002', 'memevt_new00001']);
  });

  test('superseded approved event is dropped in favor of its head', () => {
    // chain: a (approved) -> b (approved, supersedes a). Only b is a head.
    const events = [
      ev('memevt_chaina01', { ...approval }),
      ev('memevt_chainb01', { ...approval, supersedes: 'memevt_chaina01' }),
    ];
    const { approvedHeads } = reduceEvents(events);
    expect(approvedHeads.map((e) => e.event_id)).toEqual(['memevt_chainb01']);
  });

  test('a rejected head is excluded', () => {
    const events = [
      ev('memevt_rej00001', {
        status: 'rejected',
        approved_by: 'user',
        decided_at: '2026-06-09T11:00:00+00:00',
      }),
    ];
    expect(reduceEvents(events).approvedHeads).toEqual([]);
  });
});

describe('setHash determinism + change → dirty', () => {
  test('setHash is deterministic and order-independent', () => {
    const a = ev('memevt_aaaa0001', { ...approval });
    const b = ev('memevt_bbbb0001', { ...approval });
    const h1 = reduceEvents([a, b]).setHash;
    const h2 = reduceEvents([b, a]).setHash;
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  test('approving an additional event changes the setHash', () => {
    const base = [ev('memevt_aaaa0001', { ...approval })];
    const more = [...base, ev('memevt_cccc0001', { ...approval })];
    expect(reduceEvents(base).setHash).not.toBe(reduceEvents(more).setHash);
  });
});

describe('projectEventNodes', () => {
  test('approved decision → Decision node + RATIONALE_FOR edges + Source node from sources', () => {
    const decision = ev('memevt_dec00001', {
      ...approval,
      event_type: 'decision',
      text: 'use TOML parser X',
      sources: ['src_aaaa1111'],
    });
    const { nodes, edges } = projectEventNodes([decision]);
    // Decision node + Source node (the grounding source is now a node, not dangling).
    const decisionNode = nodes.find((n) => n.id === 'decision:memevt_dec00001');
    expect(decisionNode?.node_type).toBe('Decision');
    const sourceNode = nodes.find((n) => n.id === 'source:src_aaaa1111');
    expect(sourceNode?.node_type).toBe('Source');
    expect(sourceNode?.name).toBe('src_aaaa1111');
    expect(edges).toHaveLength(1);
    expect(edges[0]?.edge_type).toBe('RATIONALE_FOR');
    expect(edges[0]?.from).toBe('source:src_aaaa1111');
    expect(edges[0]?.to).toBe('decision:memevt_dec00001');
    expect(edges[0]?.confidence_kind).toBe('EXTRACTED');
  });

  test('approved observation → Episode node + MENTIONS edge + Source node', () => {
    const obs = ev('memevt_obs00001', {
      ...approval,
      event_type: 'observation',
      text: 'measurement first matters',
      sources: ['src_bbbb2222'],
    });
    const { nodes, edges } = projectEventNodes([obs]);
    const episode = nodes.find((n) => n.id === 'decision:memevt_obs00001');
    expect(episode?.node_type).toBe('Episode');
    expect(nodes.find((n) => n.id === 'source:src_bbbb2222')?.node_type).toBe('Source');
    expect(edges).toHaveLength(1);
    expect(edges[0]?.edge_type).toBe('MENTIONS');
    expect(edges[0]?.from).toBe('source:src_bbbb2222');
  });

  test('same source across multiple events is emitted as a single Source node (dedup)', () => {
    const a = ev('memevt_obs00001', {
      ...approval,
      event_type: 'observation',
      sources: ['src_shared01'],
    });
    const b = ev('memevt_obs00002', {
      ...approval,
      event_type: 'observation',
      sources: ['src_shared01'],
    });
    const { nodes } = projectEventNodes([a, b]);
    expect(nodes.filter((n) => n.id === 'source:src_shared01')).toHaveLength(1);
  });

  test('sensitivity=secret approved event is not projected as a node (F6 ac-5)', () => {
    const secret = ev('memevt_sec00001', {
      ...approval,
      event_type: 'observation',
      text: 'secret observation',
      sources: ['src_pub00001'],
      sensitivity: 'secret',
    });
    const { nodes, edges } = projectEventNodes([secret]);
    expect(nodes.find((n) => n.id === 'decision:memevt_sec00001')).toBeUndefined();
    // its grounding-source edge is also dropped (no node to attach to).
    expect(edges).toHaveLength(0);
    // and the source node is not pulled in solely by a secret event.
    expect(nodes.find((n) => n.id === 'source:src_pub00001')).toBeUndefined();
  });
});

describe('buildServingGraph (one-way adjacency)', () => {
  test('edges become sorted adjacency keyed by from-node', () => {
    const nodes: MemoryNode[] = [
      { id: 'a', node_type: 'Symbol', name: 'a', properties: {} },
      { id: 'b', node_type: 'Symbol', name: 'b', properties: {} },
      { id: 'c', node_type: 'Symbol', name: 'c', properties: {} },
    ];
    const edges: MemoryEdge[] = [
      {
        id: 'e1',
        from: 'a',
        to: 'c',
        edge_type: 'RELATED_TO' as const,
        confidence_kind: 'EXTRACTED' as const,
        confidence_score: 1,
        properties: {},
        provenance: {
          extraction_run_id: 'xrun_t1',
          extracted_by: 'impact' as const,
          schema_version: '0.1.0' as const,
        },
        weight: 1,
        requires_review: false,
        used_as_evidence: false,
      },
      {
        id: 'e2',
        from: 'a',
        to: 'b',
        edge_type: 'IMPORTS' as const,
        confidence_kind: 'EXTRACTED' as const,
        confidence_score: 1,
        properties: {},
        provenance: {
          extraction_run_id: 'xrun_t1',
          extracted_by: 'codeql' as const,
          schema_version: '0.1.0' as const,
        },
        weight: 1,
        requires_review: false,
        used_as_evidence: false,
      },
    ];
    const g = buildServingGraph(nodes, edges, {
      projection_id: 'proj_test00001',
      generated_at: '2026-06-09T10:00:00+00:00',
    });
    expect(g.adjacency.a).toEqual([
      { to: 'b', edge_type: 'IMPORTS' },
      { to: 'c', edge_type: 'RELATED_TO' },
    ]);
    expect(g.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });
});

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

describe('projectMemory + memoryStatus (end-to-end freshness)', () => {
  test('projects serving graph + wiki + manifest; status reports fresh', async () => {
    await seedSource('src_one00001', 'a'.repeat(64));
    await new MemoryEventStore(workDir).append(
      ev('memevt_dec00001', {
        ...approval,
        event_type: 'decision',
        text: 'pick option A',
        sources: ['src_one00001'],
      }),
    );

    const r = await projectMemory(workDir, { now: new Date('2026-06-09T12:00:00Z') });
    expect(r.node_count).toBe(2); // one Decision node + one Source node (grounding source)
    expect(r.edge_count).toBe(1); // one RATIONALE_FOR edge

    // serving graph + wiki + manifest written to localDir (derived, gitignored)
    const projDir = join(workDir, '.ditto', 'local', 'memory', 'projections');
    expect(await Bun.file(join(projDir, 'graph.json')).exists()).toBe(true);
    expect(await Bun.file(join(projDir, 'wiki', 'index.md')).exists()).toBe(true);
    expect(await Bun.file(join(projDir, 'manifest.json')).exists()).toBe(true);

    const status = await memoryStatus(workDir);
    expect(status.freshness).toBe('fresh');
    expect(status.dirty_sources).toEqual([]);
  });

  test('approved observation projects an Episode + Source node queryable via queryNeighbors', async () => {
    await seedSource('src_obs00001', 'a'.repeat(64));
    await new MemoryEventStore(workDir).append(
      ev('memevt_obs00001', {
        ...approval,
        event_type: 'observation',
        text: 'measurement first matters',
        sources: ['src_obs00001'],
      }),
    );

    const r = await projectMemory(workDir, { now: new Date('2026-06-09T12:00:00Z') });
    const ids = r.serving.nodes.map((n) => n.id);
    expect(ids).toContain('source:src_obs00001'); // F4: source is a real node, not dangling
    const episodeNode = r.serving.nodes.find((n) => n.node_type === 'Episode');
    if (!episodeNode) throw new Error('expected an Episode node for the approved observation');

    // the source node is now queryable and reaches the episode event node.
    const result = queryNeighbors(r.serving, 'source:src_obs00001', 2);
    expect(result.neighbors).toContain(episodeNode.id);
  });

  test('status is absent before any projection', async () => {
    expect((await memoryStatus(workDir)).freshness).toBe('absent');
  });

  test('approving a new event after projection makes status stale (set-hash drift)', async () => {
    await seedSource('src_one00001', 'a'.repeat(64));
    const store = new MemoryEventStore(workDir);
    await store.append(ev('memevt_appr0001', { ...approval }));
    await projectMemory(workDir, { now: new Date('2026-06-09T12:00:00Z') });
    expect((await memoryStatus(workDir)).freshness).toBe('fresh');

    // a new approved event changes the reduced approved-set → stale
    await store.append(ev('memevt_appr0002', { ...approval }));
    expect((await memoryStatus(workDir)).freshness).toBe('stale');
  });

  test('editing a source content_hash after projection marks it dirty + stale', async () => {
    await seedSource('src_one00001', 'a'.repeat(64));
    await new MemoryEventStore(workDir).append(ev('memevt_appr0001', { ...approval }));
    await projectMemory(workDir, { now: new Date('2026-06-09T12:00:00Z') });

    await seedSource('src_one00001', 'b'.repeat(64)); // content changed
    const status = await memoryStatus(workDir);
    expect(status.freshness).toBe('stale');
    expect(status.dirty_sources).toEqual(['src_one00001']);
  });

  test('secret source is not made into a Source node and its edge is omitted (F6 ac-5)', async () => {
    // a secret source grounding a non-secret event: the event stays, but the
    // secret source node and the edge to it are dropped (source-sensitivity gate).
    const secretSource: MemorySource = memorySource.parse({
      schema_version: '0.1.0',
      source_id: 'src_secret001',
      source_type: 'code',
      path: 'src/secret.ts',
      content_hash: 'a'.repeat(64),
      captured_at: '2026-06-09T10:00:00+00:00',
      revision: 'r1',
      sensitivity: 'secret',
    });
    await new MemorySourceStore(workDir).write(secretSource);
    await new MemoryEventStore(workDir).append(
      ev('memevt_obs00001', {
        ...approval,
        event_type: 'observation',
        text: 'grounded on a secret source',
        sources: ['src_secret001'],
      }),
    );

    const r = await projectMemory(workDir, { now: new Date('2026-06-09T12:00:00Z') });
    const ids = r.serving.nodes.map((n) => n.id);
    expect(ids).not.toContain('source:src_secret001');
    // the (non-secret) event node is still present.
    expect(r.serving.nodes.some((n) => n.node_type === 'Episode')).toBe(true);
    // no edge resolves into the secret source.
    for (const bucket of Object.values(r.serving.adjacency)) {
      expect(bucket.map((a) => a.to)).not.toContain('source:src_secret001');
    }
  });

  test('projection reads structure IR nodes/edges and merges decision nodes', async () => {
    const ir: MemoryGraphIr = {
      schema_version: '0.1.0',
      ir_version: 'ir_struct01',
      generated_at: '2026-06-09T09:00:00+00:00',
      extraction_run_id: 'xrun_struct01',
      nodes: [
        {
          id: 'artifact:src/a',
          node_type: 'Artifact',
          name: 'src/a',
          file_type: 'code',
          properties: {},
          provenance: {
            extraction_run_id: 'xrun_struct01',
            extracted_by: 'codeql',
            schema_version: '0.1.0',
          },
        },
      ],
      edges: [],
      hyperedges: [],
    };
    await new MemoryGraphIrStore(workDir).write(ir);
    await new MemoryEventStore(workDir).append(
      ev('memevt_dec00001', { ...approval, event_type: 'decision', text: 'd', sources: [] }),
    );
    const r = await projectMemory(workDir, { now: new Date('2026-06-09T12:00:00Z') });
    // 1 structure node + 1 decision node
    expect(r.node_count).toBe(2);
    expect(r.serving.nodes.map((n) => n.id)).toContain('artifact:src/a');
    expect(r.serving.nodes.map((n) => n.id)).toContain('decision:memevt_dec00001');
  });
});

describe('proposeEvent / approveEvent (write model §4-5 / §10-2 F2)', () => {
  test('proposeEvent creates a pending event with no approved_by', async () => {
    const proposed = await proposeEvent(workDir, {
      event_type: 'decision',
      text: 'use bun for runtime',
      sources: [],
    });
    expect(proposed.status).toBe('pending');
    expect(proposed.approved_by).toBeUndefined();
    expect(proposed.event_id).toMatch(/^memevt_/);
    // persisted immutably
    const stored = await new MemoryEventStore(workDir).get(proposed.event_id);
    expect(stored.status).toBe('pending');
  });

  test('approveEvent appends a superseding approved event without mutating the original', async () => {
    const proposed = await proposeEvent(workDir, {
      event_type: 'decision',
      text: 'use bun for runtime',
      sources: [],
    });
    const originalPath = join(workDir, '.ditto', 'memory', 'events', `${proposed.event_id}.json`);
    const beforeRaw = await readFile(originalPath, 'utf8');

    const { decision, projection } = await approveEvent(workDir, proposed.event_id, {
      by: 'user',
      approverKind: 'user',
      now: new Date('2026-06-09T12:00:00Z'),
    });

    // new immutable approved event with supersedes + invariant fields
    expect(decision.event_id).not.toBe(proposed.event_id);
    expect(decision.status).toBe('approved');
    expect(decision.approved_by).toBe('user');
    expect(decision.decided_at).toBeDefined();
    expect(decision.supersedes).toBe(proposed.event_id);

    // original file byte-for-byte unchanged (no mutation)
    const afterRaw = await readFile(originalPath, 'utf8');
    expect(afterRaw).toBe(beforeRaw);

    // re-projection reflects the approved head as a Decision node
    expect(projection.serving.nodes.map((n) => n.id)).toContain(`decision:${decision.event_id}`);
    expect(projection.serving.nodes.map((n) => n.id)).not.toContain(
      `decision:${proposed.event_id}`,
    );
  });

  test('approveEvent then reduceEvents keeps only the new approved head', async () => {
    const proposed = await proposeEvent(workDir, { event_type: 'observation', text: 'x' });
    const { decision } = await approveEvent(workDir, proposed.event_id, {
      by: 'policy',
      approverKind: 'user',
    });
    const all = await new MemoryEventStore(workDir).list();
    const { approvedHeads } = reduceEvents(all);
    expect(approvedHeads.map((e) => e.event_id)).toEqual([decision.event_id]);
  });

  test('approveEvent rejects a non-pending event id', async () => {
    const proposed = await proposeEvent(workDir, { event_type: 'observation', text: 'x' });
    await approveEvent(workDir, proposed.event_id, { by: 'user', approverKind: 'user' });
    // approving the approved decision head is not allowed (status=approved).
    const all = await new MemoryEventStore(workDir).list();
    const approved = all.find((e) => e.status === 'approved');
    if (!approved) throw new Error('expected an approved event');
    await expect(approveEvent(workDir, approved.event_id, { by: 'user' })).rejects.toBeInstanceOf(
      MemoryEventNotPendingError,
    );
  });

  test('double-approve of the same pending id is rejected and yields exactly one head', async () => {
    const proposed = await proposeEvent(workDir, { event_type: 'decision', text: 'use bun' });
    const { decision } = await approveEvent(workDir, proposed.event_id, {
      by: 'user',
      approverKind: 'user',
    });

    // second approve of the SAME (immutable, still-pending) original must reject
    await expect(
      approveEvent(workDir, proposed.event_id, { by: 'user2', approverKind: 'user' }),
    ).rejects.toBeInstanceOf(MemoryEventAlreadyDecidedError);

    // §10-2: the chain has exactly one approved head, no fork
    const all = await new MemoryEventStore(workDir).list();
    const { approvedHeads } = reduceEvents(all);
    expect(approvedHeads.map((e) => e.event_id)).toEqual([decision.event_id]);
  });

  test('approve then reject of the same pending id is rejected', async () => {
    const proposed = await proposeEvent(workDir, { event_type: 'decision', text: 'use bun' });
    await approveEvent(workDir, proposed.event_id, { by: 'user', approverKind: 'user' });

    await expect(
      approveEvent(workDir, proposed.event_id, { by: 'user', approverKind: 'user', reject: true }),
    ).rejects.toBeInstanceOf(MemoryEventAlreadyDecidedError);
  });

  test('reject path records a rejected superseding event (excluded from projection)', async () => {
    const proposed = await proposeEvent(workDir, { event_type: 'decision', text: 'maybe' });
    const { decision, projection } = await approveEvent(workDir, proposed.event_id, {
      by: 'user',
      approverKind: 'user',
      reject: true,
    });
    expect(decision.status).toBe('rejected');
    expect(decision.supersedes).toBe(proposed.event_id);
    // rejected head is not projected
    expect(projection.serving.nodes.map((n) => n.id)).not.toContain(
      `decision:${decision.event_id}`,
    );
  });

  test('actor.kind=agent proposed event approved with approverKind=agent is rejected (self-approval)', async () => {
    const proposed = await proposeEvent(workDir, {
      event_type: 'decision',
      text: 'agent guess',
      actor: { kind: 'agent' },
    });
    await expect(
      approveEvent(workDir, proposed.event_id, { by: 'agent', approverKind: 'agent' }),
    ).rejects.toBeInstanceOf(MemorySelfApprovalError);
  });

  test('agent-proposed event defaults approverKind to agent and is rejected (self-approval)', async () => {
    const proposed = await proposeEvent(workDir, {
      event_type: 'decision',
      text: 'agent guess',
      actor: { kind: 'agent' },
    });
    // omitting approverKind defaults to 'agent' → blocked
    await expect(approveEvent(workDir, proposed.event_id, { by: 'agent' })).rejects.toBeInstanceOf(
      MemorySelfApprovalError,
    );
  });

  test('agent-proposed event approved with approverKind=user passes', async () => {
    const proposed = await proposeEvent(workDir, {
      event_type: 'decision',
      text: 'agent guess',
      actor: { kind: 'agent' },
    });
    const { decision } = await approveEvent(workDir, proposed.event_id, {
      by: 'user',
      approverKind: 'user',
    });
    expect(decision.status).toBe('approved');
    expect(decision.supersedes).toBe(proposed.event_id);
  });

  test('user-proposed event approved with approverKind=agent passes (origin is user)', async () => {
    const proposed = await proposeEvent(workDir, {
      event_type: 'decision',
      text: 'user fact',
      actor: { kind: 'user' },
    });
    const { decision } = await approveEvent(workDir, proposed.event_id, {
      by: 'agent',
      approverKind: 'agent',
    });
    expect(decision.status).toBe('approved');
  });
});
