import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DriveMemberResult } from '~/core/chain-drive';
import { WorkItemStore } from '~/core/work-item-store';
import type { WorktreeMergeResult, WorktreeRemovalResult } from '~/core/worktree';
import {
  type WorktreeDriveDeps,
  type WorktreeDriveMemberFn,
  type WorktreeMergeFn,
  driveWorktrees,
} from '~/core/worktree-drive';
import type { WorkItemWorktree } from '~/schemas/work-item';

// wi_260627t82 — `driveWorktrees` orchestration. The per-member drive, merge,
// remove and push steps are all injected fakes here so the deterministic logic
// (worktree gate, drive→merge→remove sequencing, clean-only merge-back, halt
// continuation, push gating, depth cap) is exercised without real git.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-wtdrive-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function wtMeta(id: string): WorkItemWorktree {
  return {
    owning_repo: '.',
    worktree_path: `.ditto/local/worktrees/${id}`,
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
    await store.update(created.id, (cur) => ({ ...cur, worktrees: [wtMeta(created.id)] }));
  }
  if (done) {
    await store.close(created.id, 'done');
  }
  return created.id;
}

const mergedResult: WorktreeMergeResult = {
  outcomes: [{ worktree: wtMeta('x'), status: 'merged' }],
  allMerged: true,
};
function conflictResult(reason: string): WorktreeMergeResult {
  return {
    outcomes: [{ worktree: wtMeta('x'), status: 'conflicted', reason }],
    allMerged: false,
  };
}
const removedResult: WorktreeRemovalResult = {
  removed: [wtMeta('x')],
  blocked: [],
};

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
    merge: async () => mergedResult,
    removeWorktrees: async () => removedResult,
    attemptPush: async () => 'pushed',
    ...overrides,
  };
}

describe('clean merge → remove', () => {
  test('an already-done member merges cleanly and is removed', async () => {
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
      { workIds: [a], push: false, maxDepth: 20 },
    );
    expect(driveCalls).toBe(0); // already done → not re-driven
    expect(removeCalls).toBe(1);
    expect(res.ledger).toEqual([{ member_id: a, disposition: 'driven-done', removed: true }]);
    expect(res.all_driven_done).toBe(true);
    expect(res.halted_members).toEqual([]);
  });

  test('a freshly driven member is merged then removed', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    const res = await driveWorktrees(deps(store), { workIds: [a], push: false, maxDepth: 20 });
    expect(res.ledger).toEqual([{ member_id: a, disposition: 'driven-done', removed: true }]);
    expect(res.all_driven_done).toBe(true);
  });
});

describe('conflict → preserve (no removal)', () => {
  test('a conflicted merge halts the member and never removes the worktree', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    let removeCalls = 0;
    const res = await driveWorktrees(
      deps(store, {
        merge: async () => conflictResult('CONFLICT (content): merge conflict in a.txt'),
        removeWorktrees: async () => {
          removeCalls++;
          return removedResult;
        },
      }),
      { workIds: [a], push: false, maxDepth: 20 },
    );
    expect(removeCalls).toBe(0); // preserved
    expect(res.ledger).toEqual([
      {
        member_id: a,
        disposition: 'merge-conflicted',
        reason: 'CONFLICT (content): merge conflict in a.txt',
      },
    ]);
    expect(res.all_driven_done).toBe(false);
    expect(res.halted_members).toEqual([a]);
  });

  test('the conflict reason is credential-scrubbed', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    const res = await driveWorktrees(
      deps(store, {
        merge: async () => conflictResult('fatal: could not read from https://u:tok@host/x'),
      }),
      { workIds: [a], push: false, maxDepth: 20 },
    );
    expect(res.ledger[0]?.reason).toBe('fatal: could not read from https://***@host/x');
  });
});

describe('continue-on-halt across an independent set', () => {
  test('a conflicted member does not stop a later done member', async () => {
    const store = new WorkItemStore(dir);
    const bad = await createMember(store);
    const good = await createMember(store);
    const removed: string[] = [];
    const merge: WorktreeMergeFn = async (_r, id) =>
      id === bad ? conflictResult('CONFLICT in x') : mergedResult;
    const res = await driveWorktrees(
      deps(store, {
        merge,
        removeWorktrees: async (_r, id) => {
          removed.push(id);
          return removedResult;
        },
      }),
      { workIds: [bad, good], push: false, maxDepth: 20 },
    );
    expect(res.ledger.map((e) => e.disposition)).toEqual(['merge-conflicted', 'driven-done']);
    expect(res.halted_members).toEqual([bad]);
    expect(removed).toEqual([good]); // only the clean one removed
    expect(res.all_driven_done).toBe(false);
  });
});

describe('drive-step halt', () => {
  test('a member ending not-done halts and the next member still runs', async () => {
    const store = new WorkItemStore(dir);
    const blocked = await createMember(store);
    const ok = await createMember(store);
    let mergeCalls = 0;
    const driveMember: WorktreeDriveMemberFn = async (_c, id) => {
      if (id === blocked) return { outcome: 'halted', reason: 'blocked: needs a user decision' };
      await store.close(id, 'done');
      return { outcome: 'done' };
    };
    const res = await driveWorktrees(
      deps(store, {
        driveMember,
        merge: async () => {
          mergeCalls++;
          return mergedResult;
        },
      }),
      { workIds: [blocked, ok], push: false, maxDepth: 20 },
    );
    expect(res.ledger[0]).toEqual({
      member_id: blocked,
      disposition: 'halted',
      reason: 'blocked: needs a user decision',
    });
    expect(res.ledger[1]?.disposition).toBe('driven-done');
    expect(mergeCalls).toBe(1); // only the ok member reached merge
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
      { workIds: [a], push: false, maxDepth: 20 },
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
      { workIds: [a], push: false, maxDepth: 20 },
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
      { workIds: [a], push: false, maxDepth: 20 },
    );
    expect(driveCalls).toBe(0);
    expect(res.ledger[0]?.disposition).toBe('halted');
    expect(res.ledger[0]?.reason).toMatch(/terminal-not-done/);
  });
});

describe('push gating', () => {
  test('push=false → not-requested, attemptPush never called', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    let pushCalls = 0;
    const res = await driveWorktrees(
      deps(store, {
        attemptPush: async () => {
          pushCalls++;
          return 'pushed';
        },
      }),
      { workIds: [a], push: false, maxDepth: 20 },
    );
    expect(res.push).toBe('not-requested');
    expect(res.push_ready).toBe(true);
    expect(pushCalls).toBe(0);
  });

  test('push=true & all driven-done → attemptPush called once', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    const b = await createMember(store);
    const pushed: string[][] = [];
    const res = await driveWorktrees(
      deps(store, {
        attemptPush: async (members) => {
          pushed.push([...members]);
          return 'pushed';
        },
      }),
      { workIds: [a, b], push: true, maxDepth: 20 },
    );
    expect(res.push).toBe('pushed');
    expect(pushed).toEqual([[a, b]]);
  });

  test('push=true but a halt → skipped-not-ready, attemptPush never called', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    let pushCalls = 0;
    const res = await driveWorktrees(
      deps(store, {
        merge: async () => conflictResult('CONFLICT'),
        attemptPush: async () => {
          pushCalls++;
          return 'pushed';
        },
      }),
      { workIds: [a], push: true, maxDepth: 20 },
    );
    expect(res.push).toBe('skipped-not-ready');
    expect(pushCalls).toBe(0);
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
