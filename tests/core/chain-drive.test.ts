import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BranchedStemError,
  type ChainDriveDeps,
  type DriveMemberFn,
  type PushOutcome,
  driveChain,
  resolveSpine,
  scrubCredentials,
} from '~/core/chain-drive';
import { gitPush } from '~/core/git';
import { WorkItemStore } from '~/core/work-item-store';

// wi_2606277pt — `ditto work chain drive <wi>` orchestration. The per-member drive
// step is an injected fake here so the deterministic ACs (spine, halt-gates,
// ledger, roll-up, opt-in push, depth cap) are exercised without an agent loop.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-chaindrive-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const AC_PASS = {
  id: 'ac-1',
  statement: 'the command exits 0',
  verdict: 'pass' as const,
  evidence: [{ kind: 'command' as const, command: 'bun test', summary: 'exit 0' }],
};

async function createMember(store: WorkItemStore, follows?: string): Promise<string> {
  const created = await store.create({
    title: 't',
    source_request: 'r',
    goal: 'g',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'the command exits 0', verdict: 'unverified', evidence: [] },
    ],
    ...(follows !== undefined ? { follows } : {}),
  });
  return created.id;
}

/** Mark a member as a real `done`: AC pass + command evidence (so pushReadiness can hold). */
async function markDone(store: WorkItemStore, id: string): Promise<void> {
  await store.update(id, (cur) => ({ ...cur, acceptance_criteria: [AC_PASS] }));
  await store.close(id, 'done');
}

/** A driveMember that simulates a successful per-member autopilot (flips the WI done). */
function fakeDriveDone(store: WorkItemStore): DriveMemberFn {
  return async (_repoRoot, id) => {
    await markDone(store, id);
    return { outcome: 'done' };
  };
}

function deps(store: WorkItemStore, overrides: Partial<ChainDriveDeps> = {}): ChainDriveDeps {
  return {
    store,
    intentExists: async () => true,
    driveMember: fakeDriveDone(store),
    attemptPush: async () => 'pushed',
    ...overrides,
  };
}

describe('ac-1: drive members sequentially root→tip', () => {
  test('2-member chain → both driven-done, roll-up=done', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    const b = await createMember(store, a);
    const res = await driveChain(deps(store), { workId: a, push: false, maxDepth: 20 });
    expect(res.members).toEqual([a, b]);
    expect(res.ledger.map((e) => e.disposition)).toEqual(['driven-done', 'driven-done']);
    expect(res.rolled_up).toBe('done');
    expect(res.halted_member).toBeUndefined();
  });

  test('resume: an already-terminal-done member is skipped, the rest drive', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    const b = await createMember(store, a);
    await markDone(store, a); // a already done before this invocation
    const res = await driveChain(deps(store), { workId: b, push: false, maxDepth: 20 });
    expect(res.ledger).toEqual([
      { member_id: a, disposition: 'skipped-already-done' },
      { member_id: b, disposition: 'driven-done' },
    ]);
    expect(res.rolled_up).toBe('done');
  });
});

describe('ac-3: abandoned (terminal-but-not-done) member HALTS on resume', () => {
  test('an abandoned member halts the chain rather than being skipped', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    const b = await createMember(store, a);
    await store.close(a, 'abandoned');
    const res = await driveChain(deps(store), { workId: b, push: false, maxDepth: 20 });
    expect(res.halted_member).toBe(a);
    const first = res.ledger[0];
    expect(first?.disposition).toBe('halted');
    expect(first?.reason).toMatch(/abandon/i);
    // b is never reached
    expect(res.ledger.some((e) => e.member_id === b)).toBe(false);
  });
});

describe('ac-1 spine: a branched stem is rejected, naming the branch point', () => {
  test('two members both following the same predecessor → BranchedStemError', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    await createMember(store, a); // b → a
    await createMember(store, a); // c → a (branch at a)
    await expect(resolveSpine(store, a)).rejects.toThrow(BranchedStemError);
    await expect(driveChain(deps(store), { workId: a, push: false, maxDepth: 20 })).rejects.toThrow(
      new RegExp(a),
    );
  });
});

describe('ac-2: a member with no intent.json HALTS (no auto-create, no drive)', () => {
  test('missing intent → blocked-unlocked-no-intent, driveMember never called', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    const b = await createMember(store, a);
    let driveCalls = 0;
    const res = await driveChain(
      deps(store, {
        intentExists: async (id) => id !== a, // a lacks intent
        driveMember: async (_r, id) => {
          driveCalls++;
          await markDone(store, id);
          return { outcome: 'done' };
        },
      }),
      { workId: b, push: false, maxDepth: 20 },
    );
    expect(res.halted_member).toBe(a);
    expect(res.ledger[0]).toEqual({
      member_id: a,
      disposition: 'blocked-unlocked-no-intent',
      reason: 'needs-intent-lock',
    });
    expect(driveCalls).toBe(0);
    // intent was NOT created
    expect((await store.get(a)).status).toBe('draft');
  });
});

describe('ac-3: a member ending not-done HALTS and is resumable', () => {
  test('blocked member halts with its reason; prior member stays done', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    const b = await createMember(store, a);
    const halting: DriveMemberFn = async (_r, id) => {
      if (id === a) {
        await markDone(store, id);
        return { outcome: 'done' };
      }
      return { outcome: 'halted', reason: 'blocked: needs a user decision' };
    };
    const first = await driveChain(deps(store, { driveMember: halting }), {
      workId: a,
      push: false,
      maxDepth: 20,
    });
    expect(first.ledger.map((e) => e.disposition)).toEqual(['driven-done', 'halted']);
    expect(first.halted_member).toBe(b);
    expect((await store.get(a)).status).toBe('done'); // prior member preserved

    // resume: re-invoking now drives b to done; a is skipped (already done)
    const second = await driveChain(deps(store), { workId: a, push: false, maxDepth: 20 });
    expect(second.ledger).toEqual([
      { member_id: a, disposition: 'skipped-already-done' },
      { member_id: b, disposition: 'driven-done' },
    ]);
    expect(second.rolled_up).toBe('done');
  });
});

describe('ac-4: push is opt-in and never unasked', () => {
  test('default (no --push) reports push-ready but does NOT push', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    await createMember(store, a);
    let pushCalls = 0;
    const res = await driveChain(
      deps(store, {
        attemptPush: async () => {
          pushCalls++;
          return 'pushed';
        },
      }),
      { workId: a, push: false, maxDepth: 20 },
    );
    expect(res.push).toBe('not-requested');
    expect(res.push_ready).toBe(true);
    expect(pushCalls).toBe(0);
  });

  test('--push on a green, push-ready chain calls attemptPush once', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    await createMember(store, a);
    const pushed: string[][] = [];
    const res = await driveChain(
      deps(store, {
        attemptPush: async (members) => {
          pushed.push([...members]);
          return 'pushed';
        },
      }),
      { workId: a, push: true, maxDepth: 20 },
    );
    expect(res.push).toBe('pushed');
    expect(pushed.length).toBe(1);
  });

  test('--push but a push failure degrades to skipped (no throw)', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    await createMember(store, a);
    const res = await driveChain(
      deps(store, { attemptPush: async () => 'skipped-no-remote' as PushOutcome }),
      { workId: a, push: true, maxDepth: 20 },
    );
    expect(res.push).toBe('skipped-no-remote');
  });

  test('--push on a NOT-done chain reports skipped-not-ready, never attempts push', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    const b = await createMember(store, a);
    let pushCalls = 0;
    // drive only a; b halts so the chain never rolls up to done
    const halting: DriveMemberFn = async (_r, id) => {
      if (id === a) {
        await markDone(store, id);
        return { outcome: 'done' };
      }
      return { outcome: 'halted', reason: 'blocked' };
    };
    const res = await driveChain(
      deps(store, {
        driveMember: halting,
        attemptPush: async () => {
          pushCalls++;
          return 'pushed';
        },
      }),
      { workId: a, push: true, maxDepth: 20 },
    );
    expect(res.halted_member).toBe(b);
    expect(res.push).toBe('skipped-not-ready');
    expect(pushCalls).toBe(0);
  });
});

describe('ac-5: depth cap stops with a report (not silent truncation)', () => {
  test('--max-depth 1 on a 2-member chain stops at the cap', async () => {
    const store = new WorkItemStore(dir);
    const a = await createMember(store);
    const b = await createMember(store, a);
    const res = await driveChain(deps(store), { workId: a, push: false, maxDepth: 1 });
    expect(res.stopped_at_cap).toBe(true);
    expect(res.ledger.length).toBe(1);
    expect(res.ledger[0]?.member_id).toBe(a);
    expect((await store.get(b)).status).toBe('draft'); // b untouched
  });

  test('skipped already-done members do NOT consume cap budget (resume past a long done prefix)', async () => {
    const store = new WorkItemStore(dir);
    // a done prefix LONGER than maxDepth, then a non-terminal member after it.
    const maxDepth = 2;
    const prefix: string[] = [];
    let follows: string | undefined;
    for (let i = 0; i < maxDepth + 1; i++) {
      const id = await createMember(store, follows);
      await markDone(store, id);
      prefix.push(id);
      follows = id;
    }
    const tail = await createMember(store, follows); // non-terminal, after the done prefix

    const res = await driveChain(deps(store), { workId: tail, push: false, maxDepth });

    // the done prefix is skipped without exhausting the cap; the tail is actually driven.
    expect(res.stopped_at_cap).toBe(false);
    expect(res.ledger).toEqual([
      ...prefix.map((id) => ({ member_id: id, disposition: 'skipped-already-done' as const })),
      { member_id: tail, disposition: 'driven-done' },
    ]);
    expect((await store.get(tail)).status).toBe('done'); // progress made, not stop-at-cap-with-zero-progress
  });
});

describe('ac-4 secret: credentialed URLs are scrubbed', () => {
  test('scrubCredentials removes userinfo from an https URL', () => {
    expect(scrubCredentials('https://user:token@github.com/org/repo.git')).toBe(
      'https://***@github.com/org/repo.git',
    );
    expect(scrubCredentials('fatal: could not read from https://alice:s3cr3t@host/x')).toBe(
      'fatal: could not read from https://***@host/x',
    );
    // a clean URL is untouched
    expect(scrubCredentials('https://github.com/org/repo.git')).toBe(
      'https://github.com/org/repo.git',
    );
  });
});

describe('ac-4: gitPush argv — pushes HEAD with no force, graceful on failure', () => {
  function git(cwd: string, args: string[]): void {
    execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  }

  test('pushes HEAD to a local remote; a non-fast-forward is rejected (proves no --force)', async () => {
    const remote = join(dir, 'remote.git');
    const work = join(dir, 'work');
    await mkdir(work, { recursive: true });
    git(dir, ['init', '--bare', '-b', 'main', remote]);
    git(dir, ['init', '-b', 'main', work]);
    git(work, ['remote', 'add', 'origin', remote]);
    await Bun.write(join(work, 'a.txt'), 'one');
    git(work, ['add', '.']);
    git(work, ['commit', '-m', 'c1']);

    const ok = gitPush(work, 'origin', 'HEAD');
    expect(ok.ok).toBe(true);
    // remote now has the commit
    const remoteLog = execFileSync('git', ['log', '--oneline', 'main'], {
      cwd: remote,
      encoding: 'utf8',
    });
    expect(remoteLog).toMatch(/c1/);

    // diverge: rewrite local history so HEAD is NOT a fast-forward of the remote
    await Bun.write(join(work, 'a.txt'), 'two');
    git(work, ['add', '.']);
    git(work, ['commit', '--amend', '-m', 'c1-amended']);
    const nonFf = gitPush(work, 'origin', 'HEAD');
    expect(nonFf.ok).toBe(false); // would have succeeded WITH --force; proves no force
  });
});
