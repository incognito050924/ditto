import { describe, expect, test } from 'bun:test';
import { measureUnitDebt } from '~/acg/tidy/unit-debt';

// wi_260615lj6 ac-2 (ADR-0019 D3) — HEAD↔worktree absolute debt. Run the standing fitness
// analyzer on OLD (a HEAD worktree) → beforeIds and NEW (the working tree) → afterIds, then
// assessUnitDebt. Replaces refactor.ts's before==after placeholder. Fail-open throughout.

const handle = { absolutePath: '/tmp/wt-OLD', relativePath: '.ditto/local/worktrees/x' };
const baseDeps = {
  createWorktree: () => handle,
  removeWorktree: () => {},
};

describe('measureUnitDebt — OLD(HEAD worktree)↔NEW(working tree) violation counts', () => {
  test('OLD has more violations than NEW (a tidy reduced complexity) → decreased', async () => {
    const sourceRoots: string[] = [];
    let removed = false;
    const r = await measureUnitDebt(
      { repoRoot: '/repo', unitFiles: ['src/x.ts'] },
      {
        ...baseDeps,
        removeWorktree: () => {
          removed = true;
        },
        analyze: async (input) => {
          sourceRoots.push(input.sourceRoot);
          // OLD (worktree) sees 3 complex functions; NEW (repoRoot) sees 1.
          const ids =
            input.sourceRoot === handle.absolutePath
              ? ['r@src/x.ts#L1', 'r@src/x.ts#L20', 'r@src/x.ts#L40']
              : ['r@src/x.ts#L1'];
          return { ok: true, violationIds: ids };
        },
      },
    );
    expect(sourceRoots).toEqual([handle.absolutePath, '/repo']); // OLD first, then NEW
    expect(removed).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.debt).toEqual({ before: 3, after: 1, removed: 2, decreased: true });
  });

  test('no change (same violations) → not decreased', async () => {
    const r = await measureUnitDebt(
      { repoRoot: '/repo', unitFiles: ['src/x.ts'] },
      {
        ...baseDeps,
        analyze: async () => ({ ok: true, violationIds: ['r@src/x.ts#L1'] }),
      },
    );
    expect(r.ok).toBe(true);
    expect(r.debt).toEqual({ before: 1, after: 1, removed: 0, decreased: false });
  });

  test('fail-open: a fitness run degraded (ok:false) → debt unknown (ok:false), no throw', async () => {
    const r = await measureUnitDebt(
      { repoRoot: '/repo', unitFiles: ['src/x.ts'] },
      {
        ...baseDeps,
        analyze: async () => ({ ok: false, violationIds: [], degradedReason: 'codeql missing' }),
      },
    );
    expect(r.ok).toBe(false);
    expect(r.debt).toBeUndefined();
  });

  test('fail-open: worktree creation throws → ok:false, no throw', async () => {
    const r = await measureUnitDebt(
      { repoRoot: '/repo', unitFiles: ['src/x.ts'] },
      {
        ...baseDeps,
        createWorktree: () => {
          throw new Error('git worktree add failed');
        },
        analyze: async () => ({ ok: true, violationIds: [] }),
      },
    );
    expect(r.ok).toBe(false);
    expect(r.debt).toBeUndefined();
  });

  test('fail-open: analyze throws → ok:false, worktree still removed', async () => {
    let removed = false;
    const r = await measureUnitDebt(
      { repoRoot: '/repo', unitFiles: ['src/x.ts'] },
      {
        ...baseDeps,
        removeWorktree: () => {
          removed = true;
        },
        analyze: async () => {
          throw new Error('boom');
        },
      },
    );
    expect(r.ok).toBe(false);
    expect(removed).toBe(true);
  });
});
