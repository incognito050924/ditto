import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { sessionStartHandler } from '~/hooks/session-start';

// wi_260626zzx ac-2: a SessionStart fired inside a per-work-item worktree
// (raw.cwd = `<ws>/.ditto/local/worktrees/<wi>/…`) auto-binds the session pointer to
// `<wi>` in the MAIN workspace (`input.repoRoot` is already `<ws>` after ac-1 rooting),
// so evidence/leases attribute without the user naming the work item. A non-worktree
// cwd is never auto-bound (no-auto-pick), and a phantom `<wi>` not in the store is skipped.
let repo: string;
let wiId: string;
const SESSION = 'sess-start';

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-ss-'));
  const wi = await new WorkItemStore(repo).create({
    title: 't',
    source_request: 's',
    goal: 'g',
    acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
  });
  wiId = wi.id;
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const run = (raw: Record<string, unknown> | null) =>
  sessionStartHandler({ raw, repoRoot: repo, env: {} });

const pointer = () => new SessionPointerStore(repo).get(SESSION);

describe('sessionStartHandler worktree auto-binding (ac-2)', () => {
  test('binds the session to <wi> when cwd is inside the work item worktree', async () => {
    const cwd = join(repo, '.ditto', 'local', 'worktrees', wiId, 'src');
    await run({ session_id: SESSION, cwd });
    expect(await pointer()).toBe(wiId);
  });

  test('binds even when cwd is the worktree root itself', async () => {
    const cwd = join(repo, '.ditto', 'local', 'worktrees', wiId);
    await run({ session_id: SESSION, cwd });
    expect(await pointer()).toBe(wiId);
  });

  test('does NOT bind a plain (non-worktree) cwd', async () => {
    await run({ session_id: SESSION, cwd: join(repo, 'src') });
    expect(await pointer()).toBeNull();
  });

  test('does NOT bind a phantom <wi> not present in the store', async () => {
    const cwd = join(repo, '.ditto', 'local', 'worktrees', 'wi_doesnotexist', 'src');
    await run({ session_id: SESSION, cwd });
    expect(await pointer()).toBeNull();
  });

  test('no-op when session_id or cwd is missing', async () => {
    await run({ cwd: join(repo, '.ditto', 'local', 'worktrees', wiId) });
    expect(await pointer()).toBeNull();
    await run(null);
    expect(await pointer()).toBeNull();
  });

  test('always exits 0 (advisory; never blocks the session)', async () => {
    const out = await run({ session_id: SESSION, cwd: join(repo, 'src') });
    expect(out.exitCode).toBe(0);
  });
});
