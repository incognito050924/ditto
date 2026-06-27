import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInitialNodes } from '~/core/autopilot-graph';
import { type AutopilotDecision, AutopilotStore } from '~/core/autopilot-store';
import { localDir } from '~/core/ditto-paths';
import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';

let repo: string;
let store: AutopilotStore;
const WI = 'wi_storetest';

function graph(): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_storetest',
    work_item_id: WI,
    mode: 'autopilot',
    root_goal: 'goal',
    completion_boundary: 'entire_work_item',
    approval_gate: {
      status: 'not_required',
      source: 'small_reversible_policy',
      approved_at: null,
      approved_by: null,
      evidence_refs: [],
    },
    nodes: buildInitialNodes(['ac-1']),
    caps: { fix_per_node: 2, switch_per_node: 1 },
    continue_policy: {
      continue_after_approval: true,
      continue_after_checkpoint: true,
      continue_after_fixable_failure: true,
      ask_user_only_for_user_owned_decisions: true,
    },
    stop_conditions: [],
    user_interrupt_policy: 'ask_only_for_user_owned_decisions',
  };
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-aps-'));
  store = new AutopilotStore(repo);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('AutopilotStore', () => {
  test('write then get round-trips a schema-valid graph', async () => {
    await store.write(WI, graph());
    const read = await store.get(WI);
    expect(read.nodes).toHaveLength(3);
    expect(read.autopilot_id).toBe('orch_storetest');
  });

  test('updateNode mutates exactly one node and persists', async () => {
    await store.write(WI, graph());
    await store.updateNode(WI, 'N1', (n) => ({ ...n, status: 'passed' }));
    const read = await store.get(WI);
    expect(read.nodes.find((n) => n.id === 'N1')?.status).toBe('passed');
    expect(read.nodes.find((n) => n.id === 'N2')?.status).toBe('pending');
  });

  test('updateNode throws on unknown node', async () => {
    await store.write(WI, graph());
    let err: unknown;
    try {
      await store.updateNode(WI, 'N9', (n) => n);
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain('not found');
  });

  test('updateNode forbids changing the node id', async () => {
    await store.write(WI, graph());
    let err: unknown;
    try {
      await store.updateNode(WI, 'N1', (n) => ({ ...n, id: 'X' }));
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain('changed node id');
  });

  test('updateApprovalGate mutates only the gate and persists', async () => {
    await store.write(WI, graph());
    await store.updateApprovalGate(WI, (g) => ({ ...g, status: 'approved', approved_by: 'me' }));
    const read = await store.get(WI);
    expect(read.approval_gate.status).toBe('approved');
    expect(read.approval_gate.approved_by).toBe('me');
    expect(read.nodes).toHaveLength(3);
  });

  const extraNode = (id: string, depends_on: string[]): AutopilotNode => ({
    id,
    kind: 'implement',
    owner: 'implementer',
    purpose: 'p',
    status: 'pending',
    depends_on,
    acceptance_refs: [],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  });

  test('addNodes appends and persists via the store (3 → 4 nodes)', async () => {
    await store.write(WI, graph());
    await store.addNodes(WI, [extraNode('N4', ['N3'])]);
    const read = await store.get(WI);
    expect(read.nodes).toHaveLength(4);
    expect(read.nodes.find((n) => n.id === 'N4')?.depends_on).toEqual(['N3']);
  });

  test('>3-node custom subgraph round-trips (re-read deep-equals merged)', async () => {
    await store.write(WI, graph());
    const added = await store.addNodes(WI, [extraNode('N4', ['N3']), extraNode('N5', ['N4'])]);
    const read = await store.get(WI);
    expect(read.nodes).toHaveLength(5);
    expect(read.nodes).toEqual(added.nodes);
  });

  test('addNodes throws on a duplicate id (existing node ids stay stable)', async () => {
    await store.write(WI, graph());
    let err: unknown;
    try {
      await store.addNodes(WI, [extraNode('N1', [])]);
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain('duplicate node id');
    expect((await store.get(WI)).nodes).toHaveLength(3);
  });

  test('addNodes throws on a dangling depends_on', async () => {
    await store.write(WI, graph());
    let err: unknown;
    try {
      await store.addNodes(WI, [extraNode('N4', ['Nx'])]);
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain('dangling depends_on');
  });

  test('addNodes throws on a cycle-introducing addition', async () => {
    await store.write(WI, graph());
    let err: unknown;
    try {
      await store.addNodes(WI, [extraNode('N4', ['N5']), extraNode('N5', ['N4'])]);
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain('cycle');
  });

  // --- ac-7: incremental readDecisions parse + atomic O_APPEND -----------------

  const decisionsFile = (): string =>
    join(localDir(repo, 'work-items', WI), 'autopilot-decisions.jsonl');

  const dec = (n: number, over: Partial<AutopilotDecision> = {}): AutopilotDecision => ({
    ts: `2026-05-26T00:00:${String(n).padStart(2, '0')}.000Z`,
    node_id: `N${n}`,
    failure_class: 'fixable',
    decision: 'retry',
    reason: `reason-${n}`,
    attempts: { fix: n, switch: 0 },
    ...over,
  });

  /** The old full-read oracle: parse the whole file fresh, line by line. */
  const fullReadOracle = async (): Promise<AutopilotDecision[]> => {
    const text = await readFile(decisionsFile(), 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AutopilotDecision);
  };

  test('atomic O_APPEND survives concurrent appends with no lost update', async () => {
    await store.write(WI, graph());
    const N = 12;
    await Promise.all(Array.from({ length: N }, (_, i) => store.appendDecision(WI, dec(i + 1))));
    const decisions = await store.readDecisions(WI);
    expect(decisions).toHaveLength(N);
    // Every appended record survived (order is not guaranteed under a race, but
    // none was truncated/clobbered) and every line is intact JSON.
    const reasons = new Set(decisions.map((d) => d.reason));
    for (let i = 1; i <= N; i++) expect(reasons.has(`reason-${i}`)).toBe(true);
    expect(decisions).toEqual(await fullReadOracle());
  });

  test('incremental read equals a full read after each append (0/1/N)', async () => {
    await store.write(WI, graph());
    // 0 decisions
    expect(await store.readDecisions(WI)).toEqual([]);
    // append one at a time; assert field-level identity to the oracle each step
    for (let i = 1; i <= 5; i++) {
      await store.appendDecision(WI, dec(i));
      const incremental = await store.readDecisions(WI);
      expect(incremental).toEqual(await fullReadOracle());
      expect(incremental).toHaveLength(i);
      // ordered-list identity: last element is the just-appended record
      expect(incremental.at(-1)?.reason).toBe(`reason-${i}`);
    }
  });

  test('missing file reads as empty; empty file reads as empty', async () => {
    await store.write(WI, graph());
    expect(await store.readDecisions(WI)).toEqual([]); // missing
    await writeFile(decisionsFile(), '', 'utf8');
    expect(await store.readDecisions(WI)).toEqual([]); // empty
  });

  test('corrupt trailing line fails closed (throws), same as a full read', async () => {
    await store.write(WI, graph());
    await store.appendDecision(WI, dec(1));
    await store.readDecisions(WI); // warm the cache with the valid prefix
    // Append a corrupt (non-JSON) line after the valid prefix.
    await writeFile(decisionsFile(), `${JSON.stringify(dec(1))}\n{not json\n`, 'utf8');
    await expect(store.readDecisions(WI)).rejects.toThrow();
    await expect(fullReadOracle()).rejects.toThrow();
  });

  test('fail-closed full re-read when the cached prefix bytes change', async () => {
    await store.write(WI, graph());
    await store.appendDecision(WI, dec(1));
    await store.appendDecision(WI, dec(2));
    expect(await store.readDecisions(WI)).toHaveLength(2); // warm cache (size/hash)
    // Rewrite the file so the first line's BYTES change (same-ish length, different
    // content). A stale cached prefix would mask this; the reader must full re-read.
    await writeFile(
      decisionsFile(),
      `${JSON.stringify(dec(9))}\n${JSON.stringify(dec(2))}\n`,
      'utf8',
    );
    const re = await store.readDecisions(WI);
    expect(re).toEqual(await fullReadOracle());
    expect(re[0]?.reason).toBe('reason-9');
  });

  test('fail-closed full re-read when the file shrinks below the cached prefix', async () => {
    await store.write(WI, graph());
    for (let i = 1; i <= 4; i++) await store.appendDecision(WI, dec(i));
    expect(await store.readDecisions(WI)).toHaveLength(4); // warm cache
    // Truncate the log to a single record (file shrank below cached size).
    await writeFile(decisionsFile(), `${JSON.stringify(dec(1))}\n`, 'utf8');
    const re = await store.readDecisions(WI);
    expect(re).toEqual(await fullReadOracle());
    expect(re).toHaveLength(1);
  });

  test('real consumers: K-counter / disposition / .at(-1) / retro filter match a full read', async () => {
    await store.write(WI, graph());
    const ORACLE = 'oracle-unsatisfied:'; // ORACLE_UNSATISFIED_MARKER prefix used by the K counter
    await store.appendDecision(
      WI,
      dec(1, { node_id: 'NA', reason: `${ORACLE} ac-1`, criterion_ids: ['ac-1'] }),
    );
    await store.readDecisions(WI); // warm cache
    await store.appendDecision(
      WI,
      dec(2, { node_id: 'NA', reason: `${ORACLE} ac-1`, criterion_ids: ['ac-1'] }),
    );
    await store.appendDecision(
      WI,
      dec(3, { node_id: 'NA', decision: 'switch_approach', reason: 'x' }),
    );
    await store.appendDecision(WI, {
      ts: '2026-05-26T00:09:00.000Z',
      node_id: WI,
      decision: 'loop_terminated',
      disposition: 'capped',
      reason: 'loop-level iteration cap reached',
    });
    const incremental = await store.readDecisions(WI);
    const oracle = await fullReadOracle();
    // K-block counter (same-oracle, per criterion)
    const kCount = (ds: AutopilotDecision[]) =>
      ds.filter(
        (d) =>
          d.node_id === 'NA' && d.reason.startsWith(ORACLE) && d.criterion_ids?.includes('ac-1'),
      ).length;
    expect(kCount(incremental)).toBe(kCount(oracle));
    expect(kCount(incremental)).toBe(2);
    // capped/converged disposition logic
    const loopCapped = (ds: AutopilotDecision[]) =>
      ds.some((d) => d.reason.includes('loop-level iteration cap reached'));
    expect(loopCapped(incremental)).toBe(loopCapped(oracle));
    // last loop_terminated .at(-1)
    const lastTerm = (ds: AutopilotDecision[]) =>
      ds.filter((d) => d.decision === 'loop_terminated').at(-1)?.disposition;
    expect(lastTerm(incremental)).toBe(lastTerm(oracle));
    // retro / doctor retry_switch filter
    const retrySwitch = (ds: AutopilotDecision[]) =>
      ds.filter((d) => d.decision === 'retry' || d.decision === 'switch_approach').length;
    expect(retrySwitch(incremental)).toBe(retrySwitch(oracle));
    // last-decision-for-node .at(-1)
    expect(incremental.filter((d) => d.node_id === 'NA').at(-1)?.reason).toBe(
      oracle.filter((d) => d.node_id === 'NA').at(-1)?.reason,
    );
  });

  test('decisions log is append-only', async () => {
    await store.write(WI, graph());
    await store.appendDecision(WI, {
      ts: '2026-05-26T00:00:00.000Z',
      node_id: 'N2',
      failure_class: 'fixable',
      decision: 'retry',
      reason: 'transient',
      attempts: { fix: 1, switch: 0 },
    });
    await store.appendDecision(WI, {
      ts: '2026-05-26T00:01:00.000Z',
      node_id: 'N2',
      failure_class: 'wrong_approach',
      decision: 'switch_approach',
      reason: 'dead end',
      attempts: { fix: 1, switch: 1 },
    });
    const decisions = await store.readDecisions(WI);
    expect(decisions).toHaveLength(2);
    expect(decisions[1]?.decision).toBe('switch_approach');
  });
});
