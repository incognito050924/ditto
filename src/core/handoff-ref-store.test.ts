import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Handoff } from '~/schemas/handoff';
import {
  HANDOFF_REF,
  HandoffRefStore,
  assertSafeRefTreeName,
  classifyUpdateRefFailure,
} from './handoff-ref-store';
import { type SessionHandoffBuildInput, buildSessionHandoff } from './handoff-store';

/**
 * Red-first unit tests for the hidden-ref handoff store (wi_260722g7h, ac-1/ac-2).
 *
 * Each test encodes an AC clause against a THROWAWAY git fixture repo under the OS
 * tmpdir (mkdtemp) — no real origin, no network, no dependence on wall-clock time
 * (handoff timestamps are pinned via `now`). The store must talk ONLY to local git
 * plumbing (hash-object/mktree/commit-tree/update-ref) on `refs/ditto/handoffs`:
 *  - ac-1: write lands a handoff commit on the hidden ref and leaves the working
 *    tree, the current branch history and `git branch` COMPLETELY untouched; rich
 *    handoff fields survive the round-trip.
 *  - ac-2: consume returns the body and lands a deletion commit on the ref; a
 *    consumed handoff is idempotently refused on re-consume (never a silent no-op,
 *    never an unhandled throw) and — because per-repo refs are shared across
 *    worktrees — disappears for every worktree (first-consumer-wins via CAS).
 * Sweep constraints folded into ac-1/ac-2 (delegation packet):
 *  - fail-closed token scrub BEFORE any git object is created (hash-object),
 *  - tree-entry-name injection guard (newline/tab/NUL/path-sep/leading-dash/'..'),
 *  - 0-state contract: unborn ref AND emptied tree are both "no handoffs", not
 *    errors,
 *  - update-ref stderr 3-way classification (CAS loss / ref-lock contention /
 *    hard error) with a BOUNDED rebuild-retry loop on CAS loss.
 */

const fixtures: string[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const dir = fixtures.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function git(dir: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
  };
}

/** A throwaway git repo with one commit on `main` and a configured identity. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-refstore-'));
  fixtures.push(dir);
  expect(git(dir, ['init', '-b', 'main']).exitCode).toBe(0);
  expect(git(dir, ['config', 'user.email', 'fixture@example.invalid']).exitCode).toBe(0);
  expect(git(dir, ['config', 'user.name', 'Fixture']).exitCode).toBe(0);
  await Bun.write(join(dir, 'README.md'), 'fixture\n');
  expect(git(dir, ['add', 'README.md']).exitCode).toBe(0);
  expect(git(dir, ['commit', '-m', 'init']).exitCode).toBe(0);
  return dir;
}

function makeHandoff(
  sessionId: string,
  overrides: Partial<SessionHandoffBuildInput> = {},
): Handoff {
  return buildSessionHandoff({
    sessionId,
    originalIntent: 'replace file-based handoff with a hidden-ref handoff',
    fromContext: 'unit-test session',
    currentState: 'mid-flight',
    nextFirstCheck: 'read the handoff ref',
    now: new Date('2026-01-02T03:04:05.000Z'),
    ...overrides,
  });
}

describe('HandoffRefStore.write (ac-1)', () => {
  test('lands a handoff commit on refs/ditto/handoffs; working tree, branch history and git branch untouched', async () => {
    const repo = await makeRepo();
    const headBefore = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
    const branchesBefore = git(repo, ['branch', '--list']).stdout;

    const store = new HandoffRefStore(repo);
    const res = store.write(makeHandoff('sess-1'), { author: 'alice' });

    // Handoff commit exists on the hidden ref and is what write reported.
    const tip = git(repo, ['rev-parse', '--verify', HANDOFF_REF]);
    expect(tip.exitCode).toBe(0);
    expect(tip.stdout.trim()).toBe(res.commit);
    // Tree at the tip carries the handoff entry named by the stem.
    const lsTree = git(repo, ['ls-tree', '--name-only', HANDOFF_REF]);
    expect(lsTree.stdout).toContain(`${res.stem}.md`);
    // NOTHING else moved: clean status, same HEAD, same branch list, no new branch.
    expect(git(repo, ['status', '--porcelain']).stdout).toBe('');
    expect(git(repo, ['rev-parse', 'HEAD']).stdout.trim()).toBe(headBefore);
    expect(git(repo, ['branch', '--list']).stdout).toBe(branchesBefore);
  });

  test('rich fields (critical_decisions / irreversible_risks / evidence_refs) round-trip through the ref', async () => {
    const repo = await makeRepo();
    const store = new HandoffRefStore(repo);
    const h = makeHandoff('sess-rich', {
      criticalDecisions: [{ decision: 'use hidden ref', rationale: 'no branch noise' }],
      irreversibleRisks: [{ risk: 'ref history is permanent', why_irreversible: 'git objects' }],
      evidenceRefs: [{ kind: 'command', command: 'bun test', summary: 'green' }],
    });
    store.write(h, { author: 'alice' });

    const { handoffs, failures } = store.list();
    expect(failures).toEqual([]);
    expect(handoffs).toHaveLength(1);
    const got = handoffs[0];
    if (!got) throw new Error('handoff missing');
    expect(got.handoff.critical_decisions).toEqual([
      { decision: 'use hidden ref', rationale: 'no branch noise' },
    ]);
    expect(got.handoff.irreversible_risks).toEqual([
      { risk: 'ref history is permanent', why_irreversible: 'git objects' },
    ]);
    expect(got.handoff.evidence_refs).toEqual([
      { kind: 'command', command: 'bun test', summary: 'green' },
    ]);
    expect(got.body).toContain('# Handoff: sess-rich');
  });

  test('token scrub is fail-closed BEFORE the git object is created (no secret in the ref)', async () => {
    const repo = await makeRepo();
    const store = new HandoffRefStore(repo);
    const secret = `ghp_${'A'.repeat(24)}`;
    const res = store.write(makeHandoff('sess-scrub', { currentState: `leaked ${secret} here` }), {
      author: 'alice',
    });
    const show = git(repo, ['show', `${HANDOFF_REF}:${res.stem}.md`]);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).not.toContain(secret);
    expect(show.stdout).toContain('[redacted]');
  });

  test('re-writing the same stem overwrites the single entry (no duplicate handoffs)', async () => {
    const repo = await makeRepo();
    const store = new HandoffRefStore(repo);
    store.write(makeHandoff('sess-dup', { currentState: 'first' }), { author: 'alice' });
    store.write(makeHandoff('sess-dup', { currentState: 'second' }), { author: 'alice' });
    const { handoffs } = store.list();
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.handoff.current_state).toBe('second');
  });
});

describe('tree-entry injection guard', () => {
  test('rejects newline / tab / NUL / path separators / leading dash / dotdot in tree names', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a/b', 'a\\b', '-a', 'a..b', '']) {
      expect(() => assertSafeRefTreeName(bad, 'session_id')).toThrow();
    }
    expect(() => assertSafeRefTreeName('sess-ok_1', 'session_id')).not.toThrow();
  });

  test('write refuses an injection-shaped session_id BEFORE creating the ref', async () => {
    const repo = await makeRepo();
    const store = new HandoffRefStore(repo);
    expect(() =>
      store.write(makeHandoff('evil\n100644 blob deadbeef\tother.md'), { author: 'alice' }),
    ).toThrow();
    // Fail-closed: nothing was committed — the ref is still unborn.
    expect(git(repo, ['rev-parse', '--verify', '--quiet', HANDOFF_REF]).exitCode).not.toBe(0);
  });
});

describe('0-state contract', () => {
  test('unborn ref: list is empty and consume reports not_found — neither is an error', async () => {
    const repo = await makeRepo();
    const store = new HandoffRefStore(repo);
    expect(store.list()).toEqual({ handoffs: [], failures: [] });
    expect(store.consume('sess-none__alice')).toEqual({ status: 'not_found' });
    // The 0-state read must not have created the ref as a side effect.
    expect(git(repo, ['rev-parse', '--verify', '--quiet', HANDOFF_REF]).exitCode).not.toBe(0);
  });

  test('emptied tree after consuming the last handoff is "no handoffs", not an error', async () => {
    const repo = await makeRepo();
    const store = new HandoffRefStore(repo);
    const res = store.write(makeHandoff('sess-last'), { author: 'alice' });
    const consumed = store.consume(res.stem);
    expect(consumed.status).toBe('consumed');
    expect(store.list()).toEqual({ handoffs: [], failures: [] });
  });
});

describe('HandoffRefStore.consume (ac-2)', () => {
  test('returns the body and lands a deletion commit whose parent is the write commit', async () => {
    const repo = await makeRepo();
    const store = new HandoffRefStore(repo);
    const written = store.write(makeHandoff('sess-c1'), { author: 'alice' });

    const res = store.consume(written.stem);
    expect(res.status).toBe('consumed');
    if (res.status !== 'consumed') throw new Error('unreachable');
    expect(res.body).toContain('# Handoff: sess-c1');
    expect(res.handoff.scope).toEqual({ kind: 'session', session_id: 'sess-c1' });
    // Deletion commit landed on the ref, chained onto the write commit.
    expect(git(repo, ['rev-parse', HANDOFF_REF]).stdout.trim()).toBe(res.commit);
    expect(git(repo, ['rev-parse', `${HANDOFF_REF}^`]).stdout.trim()).toBe(written.commit);
    // Entry is gone from the tip tree.
    expect(git(repo, ['ls-tree', '--name-only', HANDOFF_REF]).stdout).not.toContain(
      `${written.stem}.md`,
    );
  });

  test('double consume is idempotently refused (already_consumed, no extra commit, no throw)', async () => {
    const repo = await makeRepo();
    const store = new HandoffRefStore(repo);
    const written = store.write(makeHandoff('sess-c2'), { author: 'alice' });
    expect(store.consume(written.stem).status).toBe('consumed');
    const tipAfterFirst = git(repo, ['rev-parse', HANDOFF_REF]).stdout.trim();

    const second = store.consume(written.stem);
    expect(second).toEqual({ status: 'already_consumed' });
    // Refusal is a pure read: no new commit landed on the ref.
    expect(git(repo, ['rev-parse', HANDOFF_REF]).stdout.trim()).toBe(tipAfterFirst);
  });

  test('a consumed handoff disappears for a second worktree of the same repo (shared refs)', async () => {
    const repo = await makeRepo();
    const wt = join(repo, '..', `${repo.split('/').pop()}-wt`);
    fixtures.push(wt);
    expect(git(repo, ['worktree', 'add', wt, '-b', 'wt-branch']).exitCode).toBe(0);

    const storeMain = new HandoffRefStore(repo);
    const storeWt = new HandoffRefStore(wt);
    const written = storeMain.write(makeHandoff('sess-wt'), { author: 'alice' });

    // The OTHER worktree sees the handoff (refs are per-repo, shared).
    expect(storeWt.list().handoffs.map((b) => b.stem)).toEqual([written.stem]);

    expect(storeMain.consume(written.stem).status).toBe('consumed');

    // …and after consumption it is GONE there too — not re-consumable anywhere.
    expect(storeWt.list().handoffs).toEqual([]);
    expect(storeWt.consume(written.stem)).toEqual({ status: 'already_consumed' });
  });
});

describe('CAS discipline (first-consumer-wins, bounded retry)', () => {
  test('consume loser of a CAS race re-reads and reports already_consumed (exactly one winner gets the body)', async () => {
    const repo = await makeRepo();
    const plain = new HandoffRefStore(repo);
    const written = plain.write(makeHandoff('sess-race'), { author: 'alice' });

    // Test seam: between building the deletion commit and update-ref, a competing
    // consumer wins the ref. The loser's update-ref must fail as CAS loss, re-read,
    // find the entry gone, and refuse idempotently — NEVER return the body twice.
    let fired = false;
    let winner: string | null = null;
    const racer = new HandoffRefStore(repo, {
      beforeUpdateRef: (op) => {
        if (op !== 'consume' || fired) return;
        fired = true;
        const r = plain.consume(written.stem);
        expect(r.status).toBe('consumed');
        if (r.status === 'consumed') winner = r.body;
      },
    });

    const loser = racer.consume(written.stem);
    expect(fired).toBe(true);
    expect(winner).not.toBeNull();
    expect(loser).toEqual({ status: 'already_consumed' });
  });

  test('write loser of a CAS race rebuilds on the new tip and both handoffs survive', async () => {
    const repo = await makeRepo();
    const plain = new HandoffRefStore(repo);
    let fired = false;
    const racer = new HandoffRefStore(repo, {
      beforeUpdateRef: (op) => {
        if (op !== 'write' || fired) return;
        fired = true;
        plain.write(makeHandoff('sess-b'), { author: 'bob' });
      },
    });

    const res = racer.write(makeHandoff('sess-a'), { author: 'alice' });
    expect(fired).toBe(true);
    expect(res.casRetries).toBe(1); // exactly one rebuild after the lost CAS
    const stems = plain
      .list()
      .handoffs.map((b) => b.stem)
      .sort();
    expect(stems).toEqual(['session__sess-a__alice', 'session__sess-b__bob']);
  });

  test('update-ref stderr classification is 3-way: CAS loss / ref-lock contention / hard error', () => {
    expect(
      classifyUpdateRefFailure(
        "error: cannot lock ref 'refs/ditto/handoffs': is at 1111111111111111111111111111111111111111 but expected 2222222222222222222222222222222222222222",
      ),
    ).toBe('cas_loss');
    expect(
      classifyUpdateRefFailure(
        "error: cannot lock ref 'refs/ditto/handoffs': unable to resolve reference 'refs/ditto/handoffs'",
      ),
    ).toBe('cas_loss');
    expect(
      classifyUpdateRefFailure(
        "error: cannot lock ref 'refs/ditto/handoffs': Unable to create '/repo/.git/refs/ditto/handoffs.lock': File exists.",
      ),
    ).toBe('lock_contention');
    expect(classifyUpdateRefFailure('fatal: bad object deadbeef')).toBe('error');
  });
});
