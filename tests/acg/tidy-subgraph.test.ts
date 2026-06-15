import { describe, expect, test } from 'bun:test';
import { buildTidySubgraph } from '~/acg/tidy/subgraph';
import { validateNodeAddition } from '~/core/autopilot-graph';
import type { AutopilotNode } from '~/schemas/autopilot';

const implementNode: AutopilotNode = {
  id: 'N2',
  kind: 'implement',
  owner: 'implementer',
  purpose: 'impl',
  status: 'passed',
  depends_on: ['N1'],
  acceptance_refs: ['ac-1'],
  evidence_refs: [],
  attempts: { fix: 0, switch: 0 },
};

describe('buildTidySubgraph — ④ parallel tidy nodes + ⑦ DoD replay (WU-3, §8)', () => {
  const sub = buildTidySubgraph({
    implementNodeId: 'N2',
    fileBatches: [['src/a.ts'], ['src/b.ts', 'src/c.ts']],
    acceptanceIds: ['ac-1'],
  });

  test('returns one refactor cleanup node per file batch plus one verify DoD-replay node', () => {
    const refactor = sub.filter((n) => n.kind === 'refactor');
    const verify = sub.filter((n) => n.kind === 'verify');
    expect(refactor).toHaveLength(2);
    expect(verify).toHaveLength(1);
  });

  test('cleanup nodes are refactorer-owned and scoped to their file batch', () => {
    const refactor = sub.filter((n) => n.kind === 'refactor');
    expect(refactor.every((n) => n.owner === 'refactorer')).toBe(true);
    expect(refactor[0]?.file_scope).toEqual(['src/a.ts']);
    expect(refactor[1]?.file_scope).toEqual(['src/b.ts', 'src/c.ts']);
  });

  test('cleanup nodes depend on the implement node and NOT on each other (parallel)', () => {
    const refactor = sub.filter((n) => n.kind === 'refactor');
    expect(refactor.every((n) => n.depends_on.includes('N2'))).toBe(true);
    // no cleanup node depends on another cleanup node
    const cleanupIds = new Set(refactor.map((n) => n.id));
    expect(refactor.every((n) => n.depends_on.every((d) => !cleanupIds.has(d)))).toBe(true);
  });

  test('the DoD-replay verify node depends on every cleanup node and carries the acceptance ids', () => {
    const refactor = sub.filter((n) => n.kind === 'refactor');
    const verify = sub.find((n) => n.kind === 'verify');
    expect(verify?.depends_on.sort()).toEqual(refactor.map((n) => n.id).sort());
    expect(verify?.acceptance_refs).toEqual(['ac-1']);
  });

  test('validateNodeAddition accepts the subgraph spliced onto a graph with the implement node', () => {
    expect(() => validateNodeAddition([implementNode], sub, new Set(['ac-1']))).not.toThrow();
  });
});
