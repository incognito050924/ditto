import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { completionGate, intentDriftGate } from '~/core/gates';
import { autopilot, completionBoundary, nodeKind } from '~/schemas/autopilot';
import { completionContract } from '~/schemas/completion-contract';
import { intentContract } from '~/schemas/intent';
import { workItem } from '~/schemas/work-item';

// ac-3 (wi_260710tjd) "하나의 의도 = 하나의 단위". Three LOCKS over already-correct
// behavior (VERIFY + LOCK — regression guards, no new runtime code):
//  (a) NO slice/phase work-unit exists between work-item and autopilot node. The
//      sanctioned unit chain is work-item → intent → autopilot graph → typed nodes
//      (design/implement/verify/…); this locks that vocabulary structurally.
//  (b) Delivering FEWER AC than committed is CAUGHT by the EXISTING conservation
//      guards — intentDriftGate (AC id-set conservation, H1/H2/H3) and completionGate
//      (missing-criteria) — so an in-scope item silently demoted to an untracked
//      follow-up cannot slip. No NEW gate is added: the coverage is proven, not built.
//  (c) A legitimate typed-node fan-out (many parallel implement/fix/verify nodes under
//      ONE frozen-AC graph, e.g. this WI's own ac-1/ac-2/ac-3 fan-out) is NOT flagged
//      as a forbidden slice/phase split — the discriminator that lets axis-1 (forbid
//      slicing) and axis-2 (allow typed fan-out) coexist.

// ── shared fixtures (mirror the intentDriftGate fixtures in gates.test.ts) ──
const GOAL = 'the endpoint returns 200';
const REQUEST = 'add a health endpoint';
const acList = (ids: string[]) => ids.map((id) => ({ id, statement: `${id} returns 200` }));

const mkIntent = (ids: string[]) =>
  intentContract.parse({
    schema_version: '0.1.0',
    work_item_id: 'wi_drift001',
    source_request: REQUEST,
    goal: GOAL,
    acceptance_criteria: acList(ids),
  });

const mkWorkItem = (ids: string[], over: Record<string, unknown> = {}) =>
  workItem.parse({
    schema_version: '0.1.0',
    id: 'wi_drift001',
    title: 'drift',
    source_request: REQUEST,
    goal: GOAL,
    acceptance_criteria: acList(ids),
    created_at: '2026-06-06T00:00:00Z',
    updated_at: '2026-06-06T00:00:00Z',
    ...over,
  });

interface NodeSpec {
  id: string;
  kind: string;
  owner: string;
  refs: string[];
}
const node = (id: string, kind: string, owner: string, refs: string[]): NodeSpec => ({
  id,
  kind,
  owner,
  refs,
});

/** A graph with ONE root_goal and the given typed nodes (each carrying acceptance_refs). */
const mkGraph = (nodes: NodeSpec[], over: Record<string, unknown> = {}) =>
  autopilot.parse({
    schema_version: '0.1.0',
    autopilot_id: 'orch_drift001',
    work_item_id: 'wi_drift001',
    root_goal: GOAL,
    approval_gate: { status: 'not_required' },
    caps: { fix_per_node: 2, switch_per_node: 1 },
    continue_policy: {},
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      owner: n.owner,
      purpose: `${n.kind} ${n.refs.join(',')}`,
      status: 'pending',
      acceptance_refs: n.refs,
    })),
    ...over,
  });

/** Single verify node covering exactly `refs` — the minimal conserved graph. */
const mkVerifyGraph = (refs: string[]) => mkGraph([node('N3', 'verify', 'verifier', refs)]);

// ── (a) VERIFY + LOCK: no slice/phase work-unit exists ──────────────────────────
describe('(a) no slice/phase work-unit exists between work-item and autopilot node (ac-3)', () => {
  // The sanctioned typed-node kinds — the ENTIRE unit vocabulary a graph fans out
  // into. A new "slice"/"phase" intermediate would change this set.
  const SANCTIONED_TYPED_KINDS = [
    'research',
    'design',
    'implement',
    'review',
    'verify',
    'fix',
    'e2e',
    'docs',
    'knowledge',
    'security',
    'refactor',
    'retro',
    'cleanup',
    'e2e-author',
    'test',
  ];

  test('the typed-node vocabulary (nodeKind) declares NO slice/phase unit', () => {
    expect(nodeKind.options).not.toContain('slice');
    expect(nodeKind.options).not.toContain('phase');
  });

  test('nodeKind is EXACTLY the sanctioned typed-node set (locks the unit vocabulary)', () => {
    // Cast the received union-literal array to string[] so both sides of toEqual are
    // string[] (the expected array infers as string[], not the nodeKind literal union).
    expect(([...nodeKind.options] as string[]).sort()).toEqual([...SANCTIONED_TYPED_KINDS].sort());
  });

  test('the autopilot completion boundary is the WHOLE work item — never a slice/phase sub-unit', () => {
    // completion_boundary is `entire_work_item` ONLY (schema: "never narrowed mid-run").
    // A slice/phase unit would require a narrower boundary member; there is none.
    expect(completionBoundary.options).toEqual(['entire_work_item']);
  });

  test('a parsed graph carries ONE root_goal and no slices/phases collection', () => {
    const g = mkVerifyGraph(['ac-1']);
    expect(typeof g.root_goal).toBe('string'); // one unsplit goal; only nodes fan out
    expect(Object.keys(g)).not.toContain('slices');
    expect(Object.keys(g)).not.toContain('phases');
  });

  test('grep-style: the orchestration schemas declare no quoted slice/phase unit literal', () => {
    // Word-quoted match targets a string/enum-member literal ('slice'/'phase') — NOT a
    // `text.slice(0)` method call — so it locks the unit vocabulary without false-firing
    // on future array logic. The three schemas that define the unit chain must stay clean.
    for (const f of [
      'src/schemas/autopilot.ts',
      'src/schemas/intent.ts',
      'src/schemas/work-item.ts',
    ]) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      expect(src).not.toMatch(/['"]slice['"]/i);
      expect(src).not.toMatch(/['"]phase['"]/i);
    }
  });
});

// ── (b) delivering FEWER AC than committed is CAUGHT (existing guards, no new gate) ─
describe('(b) delivering fewer AC than committed is surfaced/blocked (ac-3)', () => {
  const IDS = ['ac-1', 'ac-2', 'ac-3'];

  test('intentDriftGate H1 BLOCKS a work item that dropped a committed intent AC (scope shrink)', () => {
    // ac-3 silently demoted out of the work item's acceptance set → id-set shrink.
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(['ac-1', 'ac-2']),
      graph: mkVerifyGraph(['ac-1', 'ac-2']),
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('scope shrink') && x.includes('ac-3'))).toBe(true);
  });

  test('completionGate BLOCKS a completion delivering fewer criteria than committed (missing)', () => {
    const item = mkWorkItem(IDS);
    const completion = completionContract.parse({
      schema_version: '0.1.0',
      work_item_id: 'wi_drift001',
      declared_by: 'verifier',
      declared_at: '2026-06-06T01:00:00Z',
      summary: 'delivered fewer than committed',
      acceptance: [
        { criterion_id: 'ac-1', verdict: 'partial' },
        { criterion_id: 'ac-2', verdict: 'partial' },
      ],
      final_verdict: 'partial',
      next_handoff_path: '.ditto/handoff/x.md',
    });
    const r = completionGate(item, completion);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('missing') && x.includes('ac-3'))).toBe(true);
  });

  test('intentDriftGate H3 BLOCKS a non-pass completion that dropped a committed AC id', () => {
    // The "in-scope item demoted to an untracked follow-up" shape: the completion just
    // omits ac-3. H3 (non-pass) catches the id-set shrink — no NEW guard is needed.
    const completion = completionContract.parse({
      schema_version: '0.1.0',
      work_item_id: 'wi_drift001',
      declared_by: 'verifier',
      declared_at: '2026-06-06T01:00:00Z',
      summary: 'ac-3 quietly demoted',
      acceptance: [
        { criterion_id: 'ac-1', verdict: 'partial' },
        { criterion_id: 'ac-2', verdict: 'partial' },
      ],
      final_verdict: 'partial',
      next_handoff_path: '.ditto/handoff/x.md',
    });
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(IDS),
      graph: mkVerifyGraph(IDS),
      completion,
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('H3') && x.includes('ac-3'))).toBe(true);
  });
});

// ── (c) DISCRIMINATOR: a legitimate typed-node fan-out is NOT false-flagged ──────
describe('(c) a legitimate typed-node fan-out is not a forbidden slice/phase split (ac-3)', () => {
  const IDS = ['ac-1', 'ac-2', 'ac-3'];

  test('parallel implement/fix/verify nodes under ONE frozen-AC graph pass intentDriftGate', () => {
    // Mirrors THIS work item's own ac-1/ac-2/ac-3 fan-out: many typed nodes, ONE
    // root_goal, AC id-set conserved (union covers exactly the intent, no invented id).
    // Axis-2 (allow typed fan-out) must coexist with axis-1 (forbid slice/phase split) —
    // so this MUST pass, else the forbid-guard would over-fire on legitimate parallelism.
    const graph = mkGraph([
      node('impl-ac1', 'implement', 'implementer', ['ac-1']),
      node('impl-ac2', 'implement', 'implementer', ['ac-2']),
      node('impl-ac3', 'implement', 'implementer', ['ac-3']),
      node('fix-ac2', 'fix', 'implementer', ['ac-2']),
      node('verify-all', 'verify', 'verifier', ['ac-1', 'ac-2', 'ac-3']),
    ]);
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(IDS),
      graph,
    });
    expect(r.pass).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.advisories).toEqual([]);
  });

  test('the fan-out spans many nodes but conserves ONE root_goal and the exact AC id-set', () => {
    // Structural corroboration: fan-out = MORE nodes, SAME goal, SAME AC ids. This is
    // what distinguishes typed fan-out from a scope-splitting slice/phase unit.
    const graph = mkGraph([
      node('impl-ac1', 'implement', 'implementer', ['ac-1']),
      node('impl-ac2', 'implement', 'implementer', ['ac-2']),
      node('impl-ac3', 'implement', 'implementer', ['ac-3']),
    ]);
    expect(graph.nodes.length).toBeGreaterThan(1);
    expect(graph.root_goal).toBe(GOAL);
    const coveredIds = new Set(graph.nodes.flatMap((n) => n.acceptance_refs));
    expect([...coveredIds].sort()).toEqual([...IDS].sort());
  });
});
