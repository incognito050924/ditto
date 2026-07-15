import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DriveMemberResult } from '~/core/chain-drive';
import { WorkItemStore } from '~/core/work-item-store';
import type { LandStatus, WorktreeLandResult, WorktreeRemovalResult } from '~/core/worktree';
import {
  type WorktreeDriveDeps,
  type WorktreeDriveMemberFn,
  type WorktreeLandFn,
  driveWorktrees,
} from '~/core/worktree-drive';
import type { WorkItemWorktree } from '~/schemas/work-item';

// wi_2607156f8 — `driveWorktrees` orchestration. The per-member drive, LAND (push to
// origin) and remove steps are all injected fakes here so the deterministic logic
// (worktree gate, drive→land→remove sequencing, user-gated land, C5 failure-class
// distinction, C1 partial-land reporting, halt continuation, depth cap) is exercised
// without real git/network. Landing = pushing straight to origin/<default>; it is
// user-gated, so it fires only with `push:true`.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-wtdrive-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function wt(id: string, repo = '.'): WorkItemWorktree {
  return {
    owning_repo: repo,
    worktree_path: `.ditto/local/worktrees/${id}${repo === '.' ? '' : `/${repo}`}`,
    branch: `ditto/${id}`,
  };
}

/** Create a member; optionally give it a '.' worktree and/or close it done. */
async function createMember(
  store: WorkItemStore,
  opts: { worktree?: boolean; done?: boolean } = {},
): Promise<string> {
  const { worktree = true, done = false } = opts;
  const created = await store.create({
    title: 't',
    source_request: 'r',
    goal: 'g',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'the command exits 0', verdict: 'unverified', evidence: [] },
    ],
  });
  if (worktree) {
    await store.update(created.id, (cur) => ({ ...cur, worktrees: [wt(created.id)] }));
  }
  if (done) {
    await store.close(created.id, 'done');
  }
  return created.id;
}

// ── land-result fixtures ──────────────────────────────────────────────────────
const landedAll = (repos: string[] = ['.']): WorktreeLandResult => ({
  outcomes: repos.map((r) => ({ worktree: wt('x', r), status: 'landed' as LandStatus })),
  allLanded: true,
  anyLanded: true,
});
const skippedNoOrigin: WorktreeLandResult = {
  outcomes: [{ worktree: wt('x'), status: 'skipped-no-origin', reason: 'no origin' }],
  allLanded: false,
  anyLanded: false,
};
function landFailed(status: LandStatus, reason: string): WorktreeLandResult {
  return {
    outcomes: [{ worktree: wt('x'), status, reason }],
    allLanded: false,
    anyLanded: false,
  };
}
/** A multi-repo partial land: the sub-repo landed, then '.' hard-failed. */
function partialLand(): WorktreeLandResult {
  return {
    outcomes: [
      { worktree: wt('x', 'sub'), status: 'landed' },
      { worktree: wt('x', '.'), status: 'auth-or-network-failed', reason: 'boom' },
    ],
    allLanded: false,
    anyLanded: true,
  };
}
const removedResult: WorktreeRemovalResult = { removed: [wt('x')], blocked: [] };

/** A driveMember that flips the member done (simulating a successful autopilot). */
function fakeDriveDone(store: WorkItemStore): WorktreeDriveMemberFn {
  return async (_cwd, id) => {
    await store.close(id, 'done');
    return { outcome: 'done' };
  };
}

function deps(store: WorkItemStore, overrides: Partial<WorktreeDriveDeps> = {}): WorktreeDriveDeps {
  return {
    store,
    intentExists: async () => true,
    driveMember: fakeDriveDone(store),
    land: async () => landedAll(),
    removeWorktrees: async () => removedResult,
    ...overrides,
  };
}

describe('land (with --push) → remove', () => {
  test('an already-done member lands and is torn down', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store, { done: true });
    let removeCalls = 0;
    let driveCalls = 0;
    const res = await driveWorktrees(
      deps(store, {
        driveMember: async (_c, _id) => {
          driveCalls++;
          return { outcome: 'done' } as DriveMemberResult;
        },
        removeWorktrees: async () => {
          removeCalls++;
          return removedResult;
        },
      }),
      { workIds: [a], push: true, maxDepth: 20 },
    );
    expect(driveCalls).toBe(0); // already done → not re-driven
    expect(removeCalls).toBe(1);
    expect(res.ledger).toEqual([
      { member_id: a, disposition: 'driven-done', removed: true, landed_repos: ['.'] },
    ]);
    expect(res.all_landed).toBe(true);
    expect(res.all_driven_done).toBe(true);
    expect(res.halted_members).toEqual([]);
  });

  test('a freshly driven member is landed then removed', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    const res = await driveWorktrees(deps(store), { workIds: [a], push: true, maxDepth: 20 });
    expect(res.ledger[0]?.disposition).toBe('driven-done');
    expect(res.ledger[0]?.removed).toBe(true);
    expect(res.all_landed).toBe(true);
  });
});

describe('land is user-gated (no --push → no push)', () => {
  test('push:false drives to done but never lands or tears down', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    let landCalls = 0;
    let removeCalls = 0;
    const res = await driveWorktrees(
      deps(store, {
        land: async () => {
          landCalls++;
          return landedAll();
        },
        removeWorktrees: async () => {
          removeCalls++;
          return removedResult;
        },
      }),
      { workIds: [a], push: false, maxDepth: 20 },
    );
    expect(landCalls).toBe(0); // a push is irreversible + user-gated
    expect(removeCalls).toBe(0); // worktree preserved for a manual land
    expect(res.ledger[0]?.disposition).toBe('driven-not-landed');
    expect(res.all_driven_done).toBe(true); // the drive DID reach done
    expect(res.all_landed).toBe(false);
    expect(res.push_requested).toBe(false);
  });
});

describe('C5 — surface failure classes distinctly', () => {
  test.each([
    ['push-gate-rejected', 'push-gate: `bun test` failed'],
    ['auth-or-network-failed', 'fatal: Authentication failed'],
    ['non-ff-retry-exhausted', 'still non-fast-forward after 3 retries'],
    ['rebase-conflict', 'CONFLICT (content): merge conflict in a.txt'],
  ] as [LandStatus, string][])(
    'a %s land is land-failed (never driven-done, never collapsed into a benign skip)',
    async (status, reason) => {
      const store = new WorkItemStore(dir);
      const a = await createMember(store);
      let removeCalls = 0;
      const res = await driveWorktrees(
        deps(store, {
          land: async () => landFailed(status, reason),
          removeWorktrees: async () => {
            removeCalls++;
            return removedResult;
          },
        }),
        { workIds: [a], push: true, maxDepth: 20 },
      );
      expect(removeCalls).toBe(0); // failed land → worktree PRESERVED (never force-deleted)
      expect(res.ledger[0]?.disposition).toBe('land-failed');
      expect(res.ledger[0]?.disposition).not.toBe('driven-done');
      expect(res.ledger[0]?.disposition).not.toBe('driven-not-landed'); // not a benign skip
      expect(res.ledger[0]?.reason).toContain(status); // the class is surfaced
      expect(res.land_failed_members).toEqual([a]);
      expect(res.all_landed).toBe(false);
    },
  );

  test('a benign no-origin skip is driven-not-landed (NOT land-failed)', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    const res = await driveWorktrees(deps(store, { land: async () => skippedNoOrigin }), {
      workIds: [a],
      push: true,
      maxDepth: 20,
    });
    expect(res.ledger[0]?.disposition).toBe('driven-not-landed');
    expect(res.land_failed_members).toEqual([]);
  });

  test('a land failure reason is credential-scrubbed (C6)', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    const res = await driveWorktrees(
      deps(store, {
        land: async () =>
          landFailed('auth-or-network-failed', 'fatal: could not read from https://u:tok@host/x'),
      }),
      { workIds: [a], push: true, maxDepth: 20 },
    );
    expect(res.ledger[0]?.reason).toContain('https://***@host/x');
    expect(res.ledger[0]?.reason).not.toContain('tok');
  });
});

describe('C1 — multi-repo partial land reports WHICH repos landed', () => {
  test('a sub-repo lands but a later repo fails → land-failed, landed_repos names the landed one', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    let removeCalls = 0;
    const res = await driveWorktrees(
      deps(store, {
        land: async () => partialLand(),
        removeWorktrees: async () => {
          removeCalls++;
          return removedResult;
        },
      }),
      { workIds: [a], push: true, maxDepth: 20 },
    );
    expect(res.ledger[0]?.disposition).toBe('land-failed'); // not all-or-nothing "done"
    expect(res.ledger[0]?.landed_repos).toEqual(['sub']); // the irreversible partial land is reported
    expect(res.ledger[0]?.reason).toContain('auth-or-network-failed');
    expect(removeCalls).toBe(0); // partial land → worktrees preserved
    expect(res.all_landed).toBe(false);
  });
});

describe('continue-on-halt across an independent set', () => {
  test('a land-failed member does not stop a later done member', async () => {
    const store = new WorkItemStore(dir);
    const bad = await createMember(store);
    const good = await createMember(store);
    const removed: string[] = [];
    const land: WorktreeLandFn = async (_r, id) =>
      id === bad ? landFailed('rebase-conflict', 'CONFLICT in x') : landedAll();
    const res = await driveWorktrees(
      deps(store, {
        land,
        removeWorktrees: async (_r, id) => {
          removed.push(id);
          return removedResult;
        },
      }),
      { workIds: [bad, good], push: true, maxDepth: 20 },
    );
    expect(res.ledger.map((e) => e.disposition)).toEqual(['land-failed', 'driven-done']);
    expect(res.land_failed_members).toEqual([bad]);
    expect(removed).toEqual([good]); // only the fully-landed one torn down
    expect(res.all_landed).toBe(false);
  });
});

describe('drive-step halt', () => {
  test('a member ending not-done halts and the next member still runs', async () => {
    const store = new WorkItemStore(dir);
    const blocked = await createMember(store);
    const ok = await createMember(store);
    let landCalls = 0;
    const driveMember: WorktreeDriveMemberFn = async (_c, id) => {
      if (id === blocked) return { outcome: 'halted', reason: 'blocked: needs a user decision' };
      await store.close(id, 'done');
      return { outcome: 'done' };
    };
    const res = await driveWorktrees(
      deps(store, {
        driveMember,
        land: async () => {
          landCalls++;
          return landedAll();
        },
      }),
      { workIds: [blocked, ok], push: true, maxDepth: 20 },
    );
    expect(res.ledger[0]).toEqual({
      member_id: blocked,
      disposition: 'halted',
      reason: 'blocked: needs a user decision',
    });
    expect(res.ledger[1]?.disposition).toBe('driven-done');
    expect(landCalls).toBe(1); // only the ok member reached land
    expect(res.halted_members).toEqual([blocked]);
  });
});

describe('worktree gate', () => {
  test('a member with no DITTO worktree halts with no-worktree and is not driven', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store, { worktree: false });
    let driveCalls = 0;
    const res = await driveWorktrees(
      deps(store, {
        driveMember: async (_c, _id) => {
          driveCalls++;
          return { outcome: 'done' } as DriveMemberResult;
        },
      }),
      { workIds: [a], push: true, maxDepth: 20 },
    );
    expect(driveCalls).toBe(0);
    expect(res.ledger[0]?.disposition).toBe('halted');
    expect(res.ledger[0]?.reason).toMatch(/no-worktree/);
    expect(res.halted_members).toEqual([a]);
  });
});

describe('intent-lock gate', () => {
  test('a member without intent.json halts with needs-intent-lock, not driven', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    let driveCalls = 0;
    const res = await driveWorktrees(
      deps(store, {
        intentExists: async () => false,
        driveMember: async (_c, _id) => {
          driveCalls++;
          return { outcome: 'done' } as DriveMemberResult;
        },
      }),
      { workIds: [a], push: true, maxDepth: 20 },
    );
    expect(driveCalls).toBe(0);
    expect(res.ledger[0]).toEqual({
      member_id: a,
      disposition: 'halted',
      reason: 'needs-intent-lock',
    });
  });
});

describe('terminal-not-done gate', () => {
  test('an abandoned member halts and is not driven', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    await store.close(a, 'abandoned');
    let driveCalls = 0;
    const res = await driveWorktrees(
      deps(store, {
        driveMember: async (_c, _id) => {
          driveCalls++;
          return { outcome: 'done' } as DriveMemberResult;
        },
      }),
      { workIds: [a], push: true, maxDepth: 20 },
    );
    expect(driveCalls).toBe(0);
    expect(res.ledger[0]?.disposition).toBe('halted');
    expect(res.ledger[0]?.reason).toMatch(/terminal-not-done/);
  });
});

describe('depth cap', () => {
  test('maxDepth stops once driven members reach the cap', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    const b = await createMember(store);
    const res = await driveWorktrees(deps(store), { workIds: [a, b], push: false, maxDepth: 1 });
    expect(res.stopped_at_cap).toBe(true);
    expect(res.ledger.length).toBe(1);
    expect(res.ledger[0]?.member_id).toBe(a);
    expect((await store.get(b)).status).toBe('draft'); // b untouched
  });
});
