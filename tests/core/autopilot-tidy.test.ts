import { describe, expect, test } from 'bun:test';
import type { TidyDiffStat } from '~/acg/tidy/classifier';
import { planTidyOnImplementPass } from '~/core/autopilot-tidy';

const stat = (files: TidyDiffStat['files']): TidyDiffStat => ({ files });

describe('planTidyOnImplementPass — ⓪ classify + ④/⑦ subgraph splice plan (WU-3, ac-1)', () => {
  test('ENTER on an over-threshold code diff returns a tidy subgraph rooted at the implement node', () => {
    const plan = planTidyOnImplementPass({
      implementNodeId: 'N2',
      diffStat: stat([
        { path: 'src/a.ts', added: 30, removed: 10, isCode: true },
        { path: 'src/b.ts', added: 5, removed: 0, isCode: true },
      ]),
      acceptanceIds: ['ac-1'],
      existingNodeIds: ['N1', 'N2', 'N3'],
    });
    expect(plan.classification.decision).toBe('ENTER');
    expect(plan.nodes.length).toBeGreaterThan(0);
    // one refactor cleanup node per code file + one verify replay node
    const refactor = plan.nodes.filter((n) => n.kind === 'refactor');
    const verify = plan.nodes.filter((n) => n.kind === 'verify');
    expect(refactor.length).toBe(2);
    expect(verify.length).toBe(1);
    // cleanup nodes depend on the implement node (rooting the tidy stage after it)
    expect(refactor.every((n) => n.depends_on.includes('N2'))).toBe(true);
  });

  test('cleanup nodes carry a DECLARED file_scope so the lease is enforceable (ac-2 precondition)', () => {
    const plan = planTidyOnImplementPass({
      implementNodeId: 'N2',
      diffStat: stat([
        { path: 'src/a.ts', added: 30, removed: 10, isCode: true },
        { path: 'src/b.ts', added: 5, removed: 0, isCode: true },
      ]),
      acceptanceIds: ['ac-1'],
      existingNodeIds: ['N1', 'N2', 'N3'],
    });
    const refactor = plan.nodes.filter((n) => n.kind === 'refactor');
    expect(refactor.every((n) => Array.isArray(n.file_scope) && n.file_scope.length > 0)).toBe(
      true,
    );
    // each cleanup node is scoped to exactly one code file (no doc/config files)
    const scoped = refactor.flatMap((n) => n.file_scope ?? []);
    expect(scoped.sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('the replay verify node carries the implementation acceptance ids (⑦ DoD replay, ac-3)', () => {
    const plan = planTidyOnImplementPass({
      implementNodeId: 'N2',
      diffStat: stat([{ path: 'src/a.ts', added: 30, removed: 10, isCode: true }]),
      acceptanceIds: ['ac-1', 'ac-2'],
      existingNodeIds: ['N2'],
    });
    const verify = plan.nodes.find((n) => n.kind === 'verify');
    expect(verify?.acceptance_refs).toEqual(['ac-1', 'ac-2']);
  });

  test('SKIP when only docs/config changed → no tidy nodes (no code touched)', () => {
    const plan = planTidyOnImplementPass({
      implementNodeId: 'N2',
      diffStat: stat([{ path: 'README.md', added: 50, removed: 50, isCode: false }]),
      acceptanceIds: ['ac-1'],
      existingNodeIds: ['N2'],
    });
    expect(plan.classification.decision).toBe('SKIP');
    expect(plan.nodes).toEqual([]);
  });

  test('SKIP when the code diff is below threshold → no tidy nodes (small change)', () => {
    const plan = planTidyOnImplementPass({
      implementNodeId: 'N2',
      diffStat: stat([{ path: 'src/a.ts', added: 2, removed: 1, isCode: true }]),
      acceptanceIds: ['ac-1'],
      existingNodeIds: ['N2'],
    });
    expect(plan.classification.decision).toBe('SKIP');
    expect(plan.nodes).toEqual([]);
  });

  test('node ids do not collide with the existing graph (prefix derived from implement id)', () => {
    const plan = planTidyOnImplementPass({
      implementNodeId: 'N2',
      diffStat: stat([
        { path: 'src/a.ts', added: 30, removed: 10, isCode: true },
        { path: 'src/b.ts', added: 5, removed: 0, isCode: true },
      ]),
      acceptanceIds: ['ac-1'],
      existingNodeIds: ['N1', 'N2', 'N3', 'Tc1'],
    });
    const ids = plan.nodes.map((n) => n.id);
    expect(ids.every((id) => !['N1', 'N2', 'N3', 'Tc1'].includes(id))).toBe(true);
    // no duplicate ids within the generated batch
    expect(new Set(ids).size).toBe(ids.length);
  });
});
