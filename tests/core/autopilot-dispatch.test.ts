import { describe, expect, test } from 'bun:test';
import {
  buildDelegationPacket,
  decideOnFailure,
  guardChildResult,
  guardMutatingEvidence,
  isMutatingOwner,
} from '~/core/autopilot-dispatch';
import { buildInitialNodes } from '~/core/autopilot-graph';
import type { AutopilotNode } from '~/schemas/autopilot';
import type { WorkItem } from '~/schemas/work-item';

const nodes = buildInitialNodes(['ac-1', 'ac-2']);
const byKind = (kind: string) => {
  const node = nodes.find((n) => n.kind === kind);
  if (!node) throw new Error(`no ${kind} node`);
  return node;
};
const implementNode = byKind('implement');
const verifyNode = byKind('verify');
const designNode = byKind('design'); // owner: planner

const workItem = {
  id: 'wi_dispatch1',
  changed_files: ['src/password.ts'],
} as unknown as WorkItem;

const caps = { fix_per_node: 2, switch_per_node: 1 };

describe('buildDelegationPacket (6-section, Context Isolation)', () => {
  test('carries task, scope, done_when, and isolation guard', () => {
    const p = buildDelegationPacket(implementNode, workItem);
    expect(p.task).toBe(implementNode.purpose);
    expect(p.context.work_item_id).toBe('wi_dispatch1');
    expect(p.context.file_scope).toEqual(['src/password.ts']);
    expect(p.context.acceptance_refs).toEqual(['ac-1', 'ac-2']);
    expect(p.must_not_do.some((m) => m.includes('Context Isolation'))).toBe(true);
    expect(p.required_tools).toContain('Edit'); // implementer may mutate
  });

  test('read-only owners are told not to mutate', () => {
    const p = buildDelegationPacket(verifyNode, workItem);
    expect(p.required_tools).not.toContain('Edit');
    expect(p.must_not_do.some((m) => m.includes('read-only'))).toBe(true);
  });

  // Planner-intelligence contract (계약 우선): the planner is the graph generator
  // (contract §2.4). Its packet must *request* a generated_nodes lifecycle
  // subgraph so the intelligence (which nodes this task needs) is a contracted
  // responsibility, not an ad-hoc driver choice. The acceptance/splice path is
  // already wired (A-3 recordResult → addNodes); this closes the request side.
  test('a planner node packet requests a generated_nodes lifecycle subgraph', () => {
    const p = buildDelegationPacket(designNode, workItem);
    const directive = p.must_do.find((m) => m.includes('generated_nodes'));
    expect(directive).toBeTruthy();
    // names the schema field and the AC mapping the planner must honor.
    expect(directive).toContain('generated_nodes');
    expect(directive?.toLowerCase()).toContain('acceptance');
    // surfaces it in the expected outcome too, so done_when reflects the subgraph.
    expect(p.expected_outcome.toLowerCase()).toContain('subgraph');
  });

  // Variant routing (ac-2/ac-3): candidates passed in surface on the packet;
  // omitting the 3rd arg defaults to [] so every existing caller is unchanged (ac-4).
  test('variant_candidates default to [] when no 3rd arg is passed', () => {
    const p = buildDelegationPacket(implementNode, workItem);
    expect(p.variant_candidates).toEqual([]);
  });

  test('variant_candidates carry the passed specialized-subagent candidates', () => {
    const candidates = [{ name: 'sql-impl', description: 'sql migrations' }];
    const p = buildDelegationPacket(implementNode, workItem, candidates);
    expect(p.variant_candidates).toEqual(candidates);
  });

  // Warm-start memory push (§10-6 #1): the builder stays PURE & SYNCHRONOUS. It
  // never queries the graph — it injects whatever the loop hands it (or omits the
  // field). With no 5th arg, context.memory is absent (no-memory path unchanged).
  test('context.memory is absent when no memoryContext is passed (packet unchanged)', () => {
    const p = buildDelegationPacket(designNode, workItem);
    expect(p.context.memory).toBeUndefined();
    expect('memory' in p.context).toBe(false);
  });

  test('buildDelegationPacket injects the passed memoryContext into context.memory', () => {
    const memory = { related_nodes: ['sym:a', 'art:b'], decisions: ['decision:d1'] };
    const p = buildDelegationPacket(designNode, workItem, [], workItem.changed_files, memory);
    expect(p.context.memory).toEqual(memory);
    // injection + a cite-or-abstain directive because governing decisions are
    // present (ac-2); task/file_scope are otherwise identical to no-memory.
    const baseline = buildDelegationPacket(designNode, workItem);
    expect(p.task).toBe(baseline.task);
    expect(p.context.file_scope).toEqual(baseline.context.file_scope);
    expect(p.must_do.some((m) => m.toLowerCase().includes('cite'))).toBe(true);
  });

  test('no cite-or-abstain directive when memoryContext carries no decisions', () => {
    const memory = { related_nodes: ['sym:a', 'art:b'] };
    const p = buildDelegationPacket(designNode, workItem, [], workItem.changed_files, memory);
    // nothing to cite ⇒ must_do stays identical to the no-memory baseline.
    const baseline = buildDelegationPacket(designNode, workItem);
    expect(p.must_do).toEqual(baseline.must_do);
  });

  test('non-planner nodes carry no subgraph-generation directive (surgical)', () => {
    for (const node of [implementNode, verifyNode]) {
      const p = buildDelegationPacket(node, workItem);
      expect(p.must_do.some((m) => m.includes('generated_nodes'))).toBe(false);
      expect(p.expected_outcome.toLowerCase()).not.toContain('subgraph');
    }
  });

  // ADR-0024 ac-3 (② DELIVER): the implementer must receive each addressed AC's
  // STATEMENT TEXT + its assigned ORACLE, not just the id — the id-only packet was
  // the intent-loss point. Additive: acceptance_refs (ids) stays for existing
  // consumers; context.acceptance carries the resolved {id, statement, oracle}.
  test('packet carries each AC statement + assigned oracle (not just the id)', () => {
    const wiWithOracle = {
      id: 'wi_oracle1',
      changed_files: ['src/x.ts'],
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 'login rejects an empty password',
          oracle: {
            verification_method: 'dynamic_test',
            maps_to: 'ac-1',
            direction: 'forward',
          },
        },
        {
          id: 'ac-2',
          statement: 'audit log records the attempt',
          // legacy AC: no oracle
        },
      ],
    } as unknown as WorkItem;

    const p = buildDelegationPacket(implementNode, wiWithOracle);

    // additive: ids still present for existing consumers.
    expect(p.context.acceptance_refs).toEqual(['ac-1', 'ac-2']);

    // structured resolved list: id + statement (+ oracle when assigned).
    expect(p.context.acceptance).toEqual([
      {
        id: 'ac-1',
        statement: 'login rejects an empty password',
        oracle: { verification_method: 'dynamic_test', maps_to: 'ac-1', direction: 'forward' },
      },
      { id: 'ac-2', statement: 'audit log records the attempt' },
    ]);

    // human-readable done_when names what + how-judged, not just ids.
    expect(p.context.done_when).toContain('login rejects an empty password');
    expect(p.context.done_when).toContain('dynamic_test');
    expect(p.expected_outcome).toContain('login rejects an empty password');
  });

  test('an AC with no assigned oracle omits the oracle field (no breakage)', () => {
    const wiLegacy = {
      id: 'wi_legacy1',
      changed_files: ['src/x.ts'],
      acceptance_criteria: [{ id: 'ac-1', statement: 'does the thing' }],
    } as unknown as WorkItem;
    const single = { ...implementNode, acceptance_refs: ['ac-1'] };
    const p = buildDelegationPacket(single, wiLegacy);
    expect(p.context.acceptance).toEqual([{ id: 'ac-1', statement: 'does the thing' }]);
    expect(p.context.acceptance?.[0]).not.toHaveProperty('oracle');
  });

  // [VERIFY] lifecycle owners: a refactor node mutates code (Tidy First) so it is
  // approval-gated like the implementer; security/retro are read-only analysis.
  // The mutating signal is derived from the owner's toolset (Edit ⇒ mutates), so
  // the approval gate and the packet's tools can never drift apart.
  const node = (owner: AutopilotNode['owner'], kind: AutopilotNode['kind']): AutopilotNode => ({
    id: 'NX',
    kind,
    owner,
    purpose: `${kind} the change`,
    status: 'pending',
    depends_on: [],
    acceptance_refs: ['ac-1'],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  });

  test('a refactor node is mutating: gets Edit/Write and no read-only guard', () => {
    const p = buildDelegationPacket(node('refactorer', 'refactor'), workItem);
    expect(p.required_tools).toContain('Edit');
    expect(p.must_not_do.some((m) => m.includes('read-only'))).toBe(false);
    expect(isMutatingOwner('refactorer')).toBe(true);
  });

  test('security and retro nodes are read-only owners', () => {
    for (const owner of ['security-reviewer', 'retrospective'] as const) {
      const p = buildDelegationPacket(
        node(owner, owner === 'retrospective' ? 'retro' : 'security'),
        workItem,
      );
      expect(p.required_tools).not.toContain('Edit');
      expect(p.must_not_do.some((m) => m.includes('read-only'))).toBe(true);
      expect(isMutatingOwner(owner)).toBe(false);
    }
  });
});

// wi_2606264rm ac-1: an implementer node addressing a code-behavior AC (a
// design-assigned `dynamic_test` oracle) carries the red-first directive; every
// other shape (non-code oracle, no oracle, non-implementer owner) is exempt. The
// trigger is derived purely from owner + resolved acceptance, so these assert the
// committed wiring, not the prose in implementer.md.
describe('buildDelegationPacket red-first directive (ac-1)', () => {
  const RED_FIRST = 'Red-first discipline (code-behavior AC)';
  const mkNode = (owner: AutopilotNode['owner']): AutopilotNode => ({
    id: 'NR',
    kind: owner === 'refactorer' ? 'refactor' : 'implement',
    owner,
    purpose: 'make the change',
    status: 'pending',
    depends_on: [],
    acceptance_refs: ['ac-1'],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  });
  const wiWith = (oracleMethod?: string): WorkItem =>
    ({
      id: 'wi_redfirst',
      changed_files: ['src/x.ts'],
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 'login rejects an empty password',
          ...(oracleMethod
            ? {
                oracle: {
                  verification_method: oracleMethod,
                  maps_to: 'ac-1',
                  direction: 'forward',
                },
              }
            : {}),
        },
      ],
    }) as unknown as WorkItem;
  const hasRedFirst = (owner: AutopilotNode['owner'], oracleMethod?: string) =>
    buildDelegationPacket(mkNode(owner), wiWith(oracleMethod)).must_do.some((m) =>
      m.includes(RED_FIRST),
    );

  test('implementer + dynamic_test oracle → red-first directive present', () => {
    expect(hasRedFirst('implementer', 'dynamic_test')).toBe(true);
  });

  test('implementer + soft_judgment oracle (non-code AC) → exempt', () => {
    expect(hasRedFirst('implementer', 'soft_judgment')).toBe(false);
  });

  test('implementer + no assigned oracle (lightweight path) → exempt', () => {
    expect(hasRedFirst('implementer', undefined)).toBe(false);
  });

  test('refactorer + dynamic_test oracle (Tidy First, not implementer) → exempt', () => {
    expect(hasRedFirst('refactorer', 'dynamic_test')).toBe(false);
  });
});

describe('decideOnFailure (caps automatic; escalate to user beyond)', () => {
  test('fixable under cap => retry', () => {
    expect(decideOnFailure('fixable', { fix: 0, switch: 0 }, caps)).toEqual({
      decision: 'retry',
      cap_exceeded: false,
    });
  });

  test('fixable at cap => escalate + cap_exceeded (non-pass)', () => {
    expect(decideOnFailure('fixable', { fix: 2, switch: 0 }, caps)).toEqual({
      decision: 'escalate',
      cap_exceeded: true,
    });
  });

  test('wrong_approach under cap => switch_approach', () => {
    expect(decideOnFailure('wrong_approach', { fix: 0, switch: 0 }, caps)).toEqual({
      decision: 'switch_approach',
      cap_exceeded: false,
    });
  });

  test('wrong_approach at cap => escalate + cap_exceeded', () => {
    expect(decideOnFailure('wrong_approach', { fix: 0, switch: 1 }, caps)).toEqual({
      decision: 'escalate',
      cap_exceeded: true,
    });
  });

  test('blocked_external and user_decision_needed escalate to the user', () => {
    expect(decideOnFailure('blocked_external', { fix: 0, switch: 0 }, caps).decision).toBe(
      'escalate',
    );
    expect(decideOnFailure('user_decision_needed', { fix: 0, switch: 0 }, caps).decision).toBe(
      'escalate',
    );
  });
});

describe('guardChildResult (G7: completion signal ≠ completion proof)', () => {
  test('an empty / whitespace-only child result is non-contentful (not PASS)', () => {
    expect(guardChildResult('')).toMatchObject({ contentful: false, failure_class: 'fixable' });
    expect(guardChildResult('   \n\t  ')).toMatchObject({ contentful: false });
  });

  test('a bare ack ("done"/"ok"/"completed") is non-contentful (ack ≠ proof)', () => {
    for (const ack of ['done', 'Done.', 'ok', 'okay!', 'completed', 'passed', '✓', '👍']) {
      expect(guardChildResult(ack).contentful).toBe(false);
    }
  });

  test('a result carrying actual work/evidence is contentful', () => {
    expect(guardChildResult('ran `bun test` → 513 pass / 0 fail').contentful).toBe(true);
    expect(guardChildResult('edited src/gates.ts:80 to add deriveClosureMode').contentful).toBe(
      true,
    );
  });

  test('non-contentful routes through the existing failure pipeline as fixable (respawn)', () => {
    const guard = guardChildResult('');
    if (guard.contentful) throw new Error('expected non-contentful');
    // a fixable classification under cap retries (respawn smaller), never PASS.
    expect(decideOnFailure(guard.failure_class, { fix: 0, switch: 0 }, caps).decision).toBe(
      'retry',
    );
  });
});

describe('buildDelegationPacket per-node file_scope (V2)', () => {
  test('uses the explicit fileScope arg (node.file_scope) over workItem.changed_files', () => {
    const scoped: AutopilotNode = { ...implementNode, file_scope: ['src/ui/Button.tsx'] };
    const p = buildDelegationPacket(scoped, workItem, [], scoped.file_scope);
    expect(p.context.file_scope).toEqual(['src/ui/Button.tsx']);
    // not the shared work-item scope — that mismatch was the V2 leak
    expect(p.context.file_scope).not.toEqual(workItem.changed_files);
  });

  test('falls back to workItem.changed_files when fileScope is omitted', () => {
    const p = buildDelegationPacket(implementNode, workItem);
    expect(p.context.file_scope).toEqual(workItem.changed_files);
  });
});

describe('guardMutatingEvidence (G7 확장: mutating pass needs changed_files)', () => {
  test('a mutating node claiming pass with zero changed_files is non-contentful (fixable)', () => {
    expect(guardMutatingEvidence('implementer', 'pass', [])).toMatchObject({
      contentful: false,
      failure_class: 'fixable',
    });
    expect(guardMutatingEvidence('refactorer', 'pass', [])).toMatchObject({ contentful: false });
  });

  test('a mutating pass that carries changed_files is contentful', () => {
    expect(guardMutatingEvidence('implementer', 'pass', ['src/x.ts']).contentful).toBe(true);
  });

  test('a non-mutating node (read-only owner) is never blocked by this guard', () => {
    expect(guardMutatingEvidence('verifier', 'pass', []).contentful).toBe(true);
    expect(guardMutatingEvidence('reviewer', 'pass', []).contentful).toBe(true);
  });

  test('a fail outcome is untouched (the guard only constrains a pass claim)', () => {
    expect(guardMutatingEvidence('implementer', 'fail', []).contentful).toBe(true);
  });
});
