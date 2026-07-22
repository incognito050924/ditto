import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HANDOFF_REF, HandoffRefStore } from './handoff-ref-store';
import {
  HANDOFF_PUSH_REFSPEC,
  SYNC_MAX_RETRIES,
  SYNC_PUSHED_REF,
  type SyncOptions,
  assertDittoPushRefspec,
  buildSyncWarning,
  classifySyncFailure,
  detectSecretMatches,
  pendingUnpushed,
  purgeHandoffHistory,
  syncHandoffRef,
} from './handoff-ref-sync';
import { type SessionHandoffBuildInput, buildSessionHandoff } from './handoff-store';

/**
 * Red-first unit tests for the refs/ditto/*-only auto push/fetch layer
 * (wi_260722g7h, g7h-impl-ref-sync — ac-3 / ac-scrub / ac-retention-invariant /
 * ac-concurrent-push).
 *
 * Every fixture is a THROWAWAY tmpdir repo plus a `git init --bare` LOCAL origin
 * — zero real network, zero real-forge URL anywhere in this file. Fault injection:
 *  - offline           = remote URL pointing at a nonexistent path,
 *  - remote-ahead      = a second fixture clone pushes first,
 *  - truncation races  = test hooks fire a competing push between snapshot and
 *                        force-with-lease.
 *
 * AC map:
 *  - ac-3: only refs/ditto/* refspecs are pushed/fetched (fully-qualified
 *    constants + a pre-subprocess assert that THROWS before any push); code
 *    branches never move; offline → local success + loud warning + retry on the
 *    next command; persistent-auth failures get a DISTINCT credentials warning.
 *  - ac-scrub: a detection-based fail-closed gate scans every blob the push
 *    would transmit; ≥1 match (or scan failure) REFUSES the push (0 egress —
 *    asserted positively against the bare origin's ref state).
 *  - ac-retention-invariant: truncation keeps max(7 days, 50 commits), NEVER
 *    changes the ref tip tree, and absorbs remote-ahead pending batons
 *    (fetch-first) — including a baton pushed between snapshot and lease push.
 *  - ac-concurrent-push: remote-ahead → fetch + tree-level re-merge + bounded
 *    retry; deletions converge to the remote CAS winner; force stays confined
 *    to the truncation path (--force-with-lease only; a grep test pins it).
 */

const fixtures: string[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const dir = fixtures.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function git(
  dir: string,
  args: string[],
  stdin?: string,
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
  };
}

/** A bare local origin (never a real forge — ac-3's zero-network contract). */
async function makeBareOrigin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-refsync-origin-'));
  fixtures.push(dir);
  expect(git(dir, ['init', '--bare']).exitCode).toBe(0);
  return dir;
}

/** A throwaway work repo with one commit on `main` and `origin` → the given bare. */
async function makeRepo(originPath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-refsync-'));
  fixtures.push(dir);
  expect(git(dir, ['init', '-b', 'main']).exitCode).toBe(0);
  expect(git(dir, ['config', 'user.email', 'fixture@example.invalid']).exitCode).toBe(0);
  expect(git(dir, ['config', 'user.name', 'Fixture']).exitCode).toBe(0);
  await Bun.write(join(dir, 'README.md'), 'fixture\n');
  expect(git(dir, ['add', 'README.md']).exitCode).toBe(0);
  expect(git(dir, ['commit', '-m', 'init']).exitCode).toBe(0);
  expect(git(dir, ['remote', 'add', 'origin', originPath]).exitCode).toBe(0);
  return dir;
}

function makeHandoff(
  sessionId: string,
  overrides: Partial<SessionHandoffBuildInput> = {},
): ReturnType<typeof buildSessionHandoff> {
  return buildSessionHandoff({
    sessionId,
    originalIntent: 'sync the hidden-ref baton to the remote',
    fromContext: 'unit-test session',
    currentState: 'mid-flight',
    nextFirstCheck: 'read the baton ref',
    now: new Date('2026-01-02T03:04:05.000Z'),
    ...overrides,
  });
}

/** Base options: explicit private visibility (the tests inject everything). */
function opts(extra: Partial<SyncOptions> = {}): SyncOptions {
  return { visibility: 'private', op: 'command', ...extra };
}

function refTip(dir: string): string | null {
  const r = git(dir, ['rev-parse', '--verify', '--quiet', `${HANDOFF_REF}^{commit}`]);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

function treeNames(dir: string, ref: string): string[] {
  return git(dir, ['ls-tree', '--name-only', ref])
    .stdout.split('\n')
    .filter((n) => n.length > 0)
    .sort();
}

/**
 * Second-PC helper: adopt the current remote ref state, write a baton on top,
 * plain-push (fast-forward). Test-side plumbing only — the module under test is
 * NOT involved, so this deterministically simulates "another PC pushed first".
 */
function otherPcPush(repo: string, sessionId: string): string {
  expect(git(repo, ['fetch', 'origin', `+${HANDOFF_REF}:${HANDOFF_REF}`]).exitCode).toBe(0);
  const res = new HandoffRefStore(repo).write(makeHandoff(sessionId), { author: 'bob' });
  expect(git(repo, ['push', 'origin', HANDOFF_PUSH_REFSPEC]).exitCode).toBe(0);
  return res.stem;
}

/**
 * Plant a RAW entry on the ref via plumbing, bypassing the store's own pre-object
 * scrub — the only way a secret-shaped body can exist on the ref, which is
 * exactly the defense-in-depth case the push gate must catch (ac-scrub).
 */
function plantRawEntry(repo: string, name: string, content: string): void {
  const blob = git(repo, ['hash-object', '-w', '--stdin'], content).stdout.trim();
  const tip = refTip(repo);
  const kept =
    tip === null
      ? []
      : git(repo, ['ls-tree', tip])
          .stdout.split('\n')
          .filter((l) => l.length > 0);
  const lines = [...kept, `100644 blob ${blob}\t${name}`];
  const tree = git(repo, ['mktree'], `${lines.join('\n')}\n`).stdout.trim();
  const commit = git(repo, [
    'commit-tree',
    tree,
    ...(tip === null ? [] : ['-p', tip]),
    '-m',
    'planted raw entry',
  ]).stdout.trim();
  expect(git(repo, ['update-ref', HANDOFF_REF, commit]).exitCode).toBe(0);
}

/** Remove a raw entry from the ref tip via plumbing (a planted entry is not a
 *  parseable handoff, so the store's consume cannot be used to delete it). */
function removeRawEntry(repo: string, name: string): void {
  const tip = refTip(repo);
  if (tip === null) throw new Error('removeRawEntry: unborn ref');
  const kept = git(repo, ['ls-tree', tip])
    .stdout.split('\n')
    .filter((l) => l.length > 0 && !l.endsWith(`\t${name}`));
  const tree = git(repo, ['mktree'], kept.length === 0 ? '' : `${kept.join('\n')}\n`).stdout.trim();
  const commit = git(repo, ['commit-tree', tree, '-p', tip, '-m', `remove ${name}`]).stdout.trim();
  expect(git(repo, ['update-ref', HANDOFF_REF, commit]).exitCode).toBe(0);
}

function syncLogLines(repo: string): string[] {
  const path = join(repo, '.ditto', 'local', 'logs', 'handoff-sync.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}

// ─── refspec guard (ac-3: only refs/ditto/* ever crosses the wire) ────────────

describe('refspec guard (fail-closed before any subprocess)', () => {
  test('rejects a refs/heads/* remote side; accepts the refs/ditto/* constant', () => {
    // ac-3: the guard runs immediately before the git subprocess; a violation
    // must THROW before any push. The remote side (after `:`) is what lands on
    // the remote, so that is the asserted side.
    expect(() => assertDittoPushRefspec('refs/heads/main:refs/heads/main')).toThrow();
    expect(() => assertDittoPushRefspec('refs/ditto/handoffs:refs/heads/main')).toThrow();
    expect(() => assertDittoPushRefspec('main:main')).toThrow();
    expect(() => assertDittoPushRefspec(HANDOFF_PUSH_REFSPEC)).not.toThrow();
  });

  test('rejects wildcard and force-marker refspecs', () => {
    expect(() => assertDittoPushRefspec('refs/ditto/*:refs/ditto/*')).toThrow();
    expect(() => assertDittoPushRefspec(`+${HANDOFF_PUSH_REFSPEC}`)).toThrow();
  });

  test('module source contains NO plain --force / -f (force is lease-pinned truncation only)', async () => {
    // ac-concurrent-push: "강제 push는 truncation 경로에 한정" — pinned by a grep
    // over the module source: every force occurrence must be --force-with-lease.
    const src = await Bun.file(join(import.meta.dir, 'handoff-ref-sync.ts')).text();
    expect(src.length).toBeGreaterThan(0);
    expect(src.replaceAll('--force-with-lease', '').includes('--force')).toBe(false);
    expect(/'-f'/.test(src)).toBe(false);
  });
});

// ─── failure classification (ac-3: offline vs persistent-auth are distinct) ───

describe('sync failure classification', () => {
  test('persistent-auth markers classify as auth, not offline', () => {
    // ac-3 sweep constraint: auth output must NOT get the offline retry wording —
    // these four marker families are the persistent-failure branch.
    expect(classifySyncFailure('Permission denied (publickey).')).toBe('auth');
    expect(classifySyncFailure("fatal: Authentication failed for 'https://remote.invalid/x'")).toBe(
      'auth',
    );
    expect(classifySyncFailure("fatal: could not read Username for 'https://remote.invalid'")).toBe(
      'auth',
    );
    expect(classifySyncFailure('The requested URL returned error: 403')).toBe('auth');
  });

  test('non-fast-forward markers classify as non-ff (recoverable)', () => {
    expect(classifySyncFailure('! [rejected] refs/ditto/handoffs (fetch first)')).toBe('non-ff');
    expect(classifySyncFailure('failed to push some refs: non-fast-forward')).toBe('non-ff');
    expect(classifySyncFailure('! [rejected] refs/ditto/handoffs (stale info)')).toBe('non-ff');
  });

  test('unreachable-remote markers classify as offline (retry next command)', () => {
    expect(classifySyncFailure('ssh: Could not resolve hostname remote.invalid')).toBe('offline');
    expect(
      classifySyncFailure("fatal: '/no/such/path' does not appear to be a git repository"),
    ).toBe('offline');
  });

  test('auth warning tells the user to check credentials; consume op adds the re-consume window', () => {
    // ac-3 + consume carve-out: a failed consume-deletion push must SAY the
    // remote baton still exists (another PC may re-consume — at-most-duplicated).
    const authWrite = buildSyncWarning('auth', 'write', 'origin', 'HTTP 403');
    expect(authWrite.toLowerCase()).toContain('credential');
    const authConsume = buildSyncWarning('auth', 'consume', 'origin', 'HTTP 403');
    expect(authConsume.toLowerCase()).toContain('credential');
    expect(authConsume).toContain('remote baton still exists');
    const offlineConsume = buildSyncWarning('offline', 'consume', 'origin', 'no route');
    expect(offlineConsume).toContain('remote baton still exists');
    const offlineWrite = buildSyncWarning('offline', 'write', 'origin', 'no route');
    expect(offlineWrite).not.toContain('remote baton still exists');
    expect(offlineWrite.toLowerCase()).toContain('next');
  });
});

// ─── secret detection (ac-scrub: detect-and-refuse, not scrub-and-proceed) ────

describe('detectSecretMatches', () => {
  test('detects PAT / PEM / JWT / URL-credentials / high-entropy shapes; clean text is empty', () => {
    // ac-scrub: the gate DETECTS (returns matches) — it never silently replaces.
    expect(detectSecretMatches(`leaked ghp_${'A'.repeat(24)} here`).length).toBeGreaterThan(0);
    expect(
      detectSecretMatches('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')
        .length,
    ).toBeGreaterThan(0);
    expect(
      detectSecretMatches(`token eyJ${'a1B2'.repeat(4)}.${'c3D4'.repeat(4)}.${'e5F6'.repeat(4)}`)
        .length,
    ).toBeGreaterThan(0);
    expect(
      detectSecretMatches('url https://user:hunter2pass@remote.invalid/repo').length,
    ).toBeGreaterThan(0);
    // push-gate-only high-entropy heuristic: long mixed-class token
    expect(detectSecretMatches(`blob ${'aB3'.repeat(15)}`).length).toBeGreaterThan(0);
    expect(
      detectSecretMatches('an ordinary handoff body, nothing secret; path src/core/x.ts'),
    ).toEqual([]);
    // a 40-hex commit sha (lowercase, no uppercase) must NOT trip the heuristic
    expect(detectSecretMatches(`sha ${'0123456789abcdef'.repeat(3)}`)).toEqual([]);
  });
});

// ─── ac-3: push/fetch refs/ditto/* only; offline degrade; visibility gate ─────

describe('syncHandoffRef (ac-3)', () => {
  test('pushes the baton ref to the bare origin; code branches NEVER move', async () => {
    const origin = await makeBareOrigin();
    const repo = await makeRepo(origin);
    const res = new HandoffRefStore(repo).write(makeHandoff('sess-1'), { author: 'alice' });

    const out = syncHandoffRef(repo, 'origin', opts({ op: 'write' }));

    expect(out.status).toBe('pushed');
    expect(out.pushedStems).toContain(res.stem);
    // origin's baton ref equals the local tip…
    expect(git(origin, ['rev-parse', HANDOFF_REF]).stdout.trim()).toBe(refTip(repo) ?? 'MISSING');
    // …and NO code branch was pushed (ac-3: never touches refs/heads/*).
    expect(git(origin, ['for-each-ref', 'refs/heads']).stdout.trim()).toBe('');
    // pending state cleared after a successful push.
    expect(pendingUnpushed(repo).pending).toBe(false);
  });

  test('fetch side: a second repo with nothing local adopts the remote baton', async () => {
    const origin = await makeBareOrigin();
    const a = await makeRepo(origin);
    const b = await makeRepo(origin);
    const res = new HandoffRefStore(a).write(makeHandoff('sess-adopt'), { author: 'alice' });
    expect(syncHandoffRef(a, 'origin', opts({ op: 'write' })).status).toBe('pushed');

    const out = syncHandoffRef(b, 'origin', opts());
    expect(out.status).toBe('nothing-to-push');
    expect(new HandoffRefStore(b).list().batons.map((x) => x.stem)).toEqual([res.stem]);
  });

  test('offline: local success + loud warning + jsonl log + pending state; retried on the next command', async () => {
    const origin = await makeBareOrigin();
    const repo = await makeRepo(origin);
    // fault injection: offline = remote URL pointing at a nonexistent path.
    expect(
      git(repo, ['remote', 'set-url', 'origin', join(origin, 'no-such-remote.git')]).exitCode,
    ).toBe(0);
    const res = new HandoffRefStore(repo).write(makeHandoff('sess-off'), { author: 'alice' });

    const out = syncHandoffRef(repo, 'origin', opts({ op: 'write', offlineBackoffMs: 1 }));
    expect(out.status).toBe('local-only-offline');
    expect(out.warnings.length).toBeGreaterThan(0);
    // local state intact (local operations always succeed)…
    expect(new HandoffRefStore(repo).list().batons.map((x) => x.stem)).toEqual([res.stem]);
    // …failure is persisted to the jsonl channel (not just a console line)…
    expect(syncLogLines(repo).some((l) => l.includes('offline'))).toBe(true);
    // …and the unpushed baton is queryable so later commands can warn repeatedly.
    expect(pendingUnpushed(repo).pending).toBe(true);

    // "retried on the next handoff command": restore the remote, sync again → pushed.
    expect(git(repo, ['remote', 'set-url', 'origin', origin]).exitCode).toBe(0);
    const retry = syncHandoffRef(repo, 'origin', opts());
    expect(retry.status).toBe('pushed');
    expect(git(origin, ['rev-parse', HANDOFF_REF]).stdout.trim()).toBe(refTip(repo) ?? 'MISSING');
    expect(pendingUnpushed(repo).pending).toBe(false);
  });

  test('visibility gate is fail-closed: public AND unknown are refused without explicit opt-in', async () => {
    // Sweep constraint: custom refs are advertised by ls-remote and fetchable by
    // anyone on a PUBLIC repo, and a consume deletion cannot un-publish pushed
    // history — so auto-push is refused unless the caller PROVES private or
    // explicitly opts in. 'unknown' counts as public (fail-closed).
    const origin = await makeBareOrigin();
    const repo = await makeRepo(origin);
    new HandoffRefStore(repo).write(makeHandoff('sess-vis'), { author: 'alice' });

    for (const visibility of ['public', 'unknown'] as const) {
      const out = syncHandoffRef(repo, 'origin', opts({ visibility }));
      expect(out.status).toBe('public-remote-refused');
      expect(git(origin, ['rev-parse', '--verify', '--quiet', HANDOFF_REF]).exitCode).not.toBe(0);
    }
    // explicit opt-in unlocks the push (the CLI pairs this with a warning).
    const out = syncHandoffRef(
      repo,
      'origin',
      opts({ visibility: 'public', allowPublicRemote: true }),
    );
    expect(out.status).toBe('pushed');
  });
});

// ─── ac-scrub: detection-based fail-closed push gate (0 egress on refusal) ────

describe('scrub gate (ac-scrub)', () => {
  test('a planted secret blob REFUSES the push and the bare origin ref does not move (0 egress)', async () => {
    const origin = await makeBareOrigin();
    const repo = await makeRepo(origin);
    new HandoffRefStore(repo).write(makeHandoff('sess-clean'), { author: 'alice' });
    // Bypass the store's pre-object scrub via raw plumbing — defense-in-depth case.
    plantRawEntry(repo, 'evil__mallory.md', `body with ghp_${'Z'.repeat(24)} leaked`);
    const originBefore = git(origin, ['rev-parse', '--verify', '--quiet', HANDOFF_REF]);

    const out = syncHandoffRef(repo, 'origin', opts());
    expect(out.status).toBe('scrub-refused');
    // the refusal points at the offending baton entry so the user can fix it…
    expect(out.scrubFindings.some((f) => f.entry === 'evil__mallory.md')).toBe(true);
    expect(out.warnings.join('\n')).toContain('evil__mallory.md');
    // …the failure is persisted…
    expect(syncLogLines(repo).some((l) => l.includes('scrub'))).toBe(true);
    // …and POSITIVELY nothing egressed: the bare origin's ref state is unchanged.
    const originAfter = git(origin, ['rev-parse', '--verify', '--quiet', HANDOFF_REF]);
    expect(originAfter.exitCode).toBe(originBefore.exitCode);
    expect(originAfter.stdout).toBe(originBefore.stdout);
  });

  test('purge path: after consuming the offending baton, purge rewrites history and the secret blob never reaches the remote', async () => {
    // Sweep constraint (undetected-token recall path, chosen design): the leaked
    // entry is consumed/rewritten first, then purgeHandoffHistory cuts the local
    // history to a single root (same tip tree) and lease-pushes — the secret blob
    // becomes unreachable on the remote.
    const origin = await makeBareOrigin();
    const repo = await makeRepo(origin);
    new HandoffRefStore(repo).write(makeHandoff('sess-keep'), { author: 'alice' });
    const secret = `ghp_${'Q'.repeat(24)}`;
    plantRawEntry(repo, 'evil__mallory.md', `body ${secret}`);

    // The evil blob is in the would-be-transmitted history: push refused even
    // after the entry is deleted at the tip (history still carries the blob).
    removeRawEntry(repo, 'evil__mallory.md');
    expect(syncHandoffRef(repo, 'origin', opts()).status).toBe('scrub-refused');

    const purged = purgeHandoffHistory(repo, 'origin', opts());
    expect(purged.status).toBe('purged');
    // remote now has exactly the tip tree, single-commit history, no secret blob.
    expect(treeNames(origin, HANDOFF_REF)).toEqual(['session__sess-keep__alice.md']);
    expect(Number(git(origin, ['rev-list', '--count', HANDOFF_REF]).stdout.trim())).toBe(1);
    const allBlobs = git(origin, ['rev-list', '--objects', HANDOFF_REF]).stdout;
    const evilBlobStillLocal = git(repo, ['cat-file', '-t', `${HANDOFF_REF}:evil__mallory.md`]);
    expect(evilBlobStillLocal.exitCode).not.toBe(0); // gone from the tip locally too
    expect(allBlobs).not.toContain('evil__mallory.md');
  });
});

// ─── ac-concurrent-push: remote-ahead → fetch + tree re-merge + bounded retry ─

describe('remote-ahead recovery (ac-concurrent-push)', () => {
  test('a rejected push fetches, re-merges batons per-file and retries to success', async () => {
    const origin = await makeBareOrigin();
    const a = await makeRepo(origin);
    const b = await makeRepo(origin);
    const stemA1 = new HandoffRefStore(a).write(makeHandoff('sess-a1'), { author: 'alice' }).stem;
    expect(syncHandoffRef(a, 'origin', opts()).status).toBe('pushed');
    // another PC lands first → A's next push is non-fast-forward.
    const stemB1 = otherPcPush(b, 'sess-b1');
    const stemA2 = new HandoffRefStore(a).write(makeHandoff('sess-a2'), { author: 'alice' }).stem;

    const out = syncHandoffRef(a, 'origin', opts());
    expect(out.status).toBe('pushed');
    // per-file union: all three batons survive on the remote tip tree.
    expect(treeNames(origin, HANDOFF_REF)).toEqual(
      [`${stemA1}.md`, `${stemA2}.md`, `${stemB1}.md`].sort(),
    );
    expect(pendingUnpushed(a).pending).toBe(false);
  });

  test('a local consume deletion propagates through the re-merge (deletion wins over the stale remote copy)', async () => {
    const origin = await makeBareOrigin();
    const a = await makeRepo(origin);
    const b = await makeRepo(origin);
    const stemA1 = new HandoffRefStore(a).write(makeHandoff('sess-d1'), { author: 'alice' }).stem;
    expect(syncHandoffRef(a, 'origin', opts()).status).toBe('pushed');
    const stemB1 = otherPcPush(b, 'sess-d2');
    // A consumes its baton locally (deletion commit), remote is ahead with B's.
    expect(new HandoffRefStore(a).consume(stemA1).status).toBe('consumed');

    const out = syncHandoffRef(a, 'origin', opts({ op: 'consume' }));
    expect(out.status).toBe('pushed');
    expect(treeNames(origin, HANDOFF_REF)).toEqual([`${stemB1}.md`]);
  });

  test('a remote consume wins over a stale local copy (remote CAS winner holds)', async () => {
    const origin = await makeBareOrigin();
    const a = await makeRepo(origin);
    const b = await makeRepo(origin);
    const stemA1 = new HandoffRefStore(a).write(makeHandoff('sess-r1'), { author: 'alice' }).stem;
    expect(syncHandoffRef(a, 'origin', opts()).status).toBe('pushed');
    // the OTHER PC consumes A's baton and lands the deletion on the remote.
    expect(git(b, ['fetch', 'origin', `+${HANDOFF_REF}:${HANDOFF_REF}`]).exitCode).toBe(0);
    expect(new HandoffRefStore(b).consume(stemA1).status).toBe('consumed');
    expect(git(b, ['push', 'origin', HANDOFF_PUSH_REFSPEC]).exitCode).toBe(0);
    // A diverges with a NEW baton; its stale copy of the consumed one must NOT resurrect.
    const stemA2 = new HandoffRefStore(a).write(makeHandoff('sess-r2'), { author: 'alice' }).stem;

    const out = syncHandoffRef(a, 'origin', opts());
    expect(out.status).toBe('pushed');
    expect(treeNames(origin, HANDOFF_REF)).toEqual([`${stemA2}.md`]);
  });

  test('retry cap: exhausted retries degrade to local-success + warning, never an infinite loop', async () => {
    const origin = await makeBareOrigin();
    const a = await makeRepo(origin);
    const b = await makeRepo(origin);
    new HandoffRefStore(a).write(makeHandoff('sess-x0'), { author: 'alice' }).stem;
    expect(syncHandoffRef(a, 'origin', opts()).status).toBe('pushed');
    new HandoffRefStore(a).write(makeHandoff('sess-x1'), { author: 'alice' });

    // fault injection: the remote moves ahead before EVERY push attempt.
    let n = 0;
    const out = syncHandoffRef(
      a,
      'origin',
      opts({
        maxRetries: 1,
        hooks: {
          beforePush: () => {
            n += 1;
            otherPcPush(b, `sess-race-${n}`);
          },
        },
      }),
    );
    expect(out.status).toBe('sync-retry-exhausted');
    expect(n).toBe(2); // attempt 0 + exactly maxRetries=1 recovery — bounded.
    expect(out.warnings.length).toBeGreaterThan(0);
    // local success: the unpushed baton is intact and still queryable as pending.
    expect(
      new HandoffRefStore(a).list().batons.some((x) => x.stem === 'session__sess-x1__alice'),
    ).toBe(true);
    expect(pendingUnpushed(a).pending).toBe(true);
    expect(SYNC_MAX_RETRIES).toBe(3); // the default cap is a named constant contract
  });
});

// ─── ac-retention-invariant: truncation never changes the tip tree ────────────

describe('retention truncation (ac-retention-invariant)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function repoWithManyBatons(
    origin: string,
    count: number,
  ): Promise<{ repo: string; store: HandoffRefStore }> {
    const repo = await makeRepo(origin);
    const store = new HandoffRefStore(repo);
    for (let i = 0; i < count; i++) {
      store.write(makeHandoff(`sess-${String(i).padStart(3, '0')}`), { author: 'alice' });
    }
    return { repo, store };
  }

  test('history beyond max(7 days, 50 commits) is cut at push time; the tip TREE is unchanged and all batons survive', async () => {
    const origin = await makeBareOrigin();
    const { repo } = await repoWithManyBatons(origin, 60);
    const treeBefore = git(repo, ['rev-parse', `${HANDOFF_REF}^{tree}`]).stdout.trim();
    const tipDateBefore = git(repo, ['log', '-1', '--format=%cI', HANDOFF_REF]).stdout.trim();

    // now := +8 days → the 7-day window keeps nothing, so max(7d, 50) = newest 50.
    const out = syncHandoffRef(repo, 'origin', opts({ now: new Date(Date.now() + 8 * DAY) }));
    expect(out.status).toBe('pushed');

    // invariant: truncation NEVER changes the ref tip tree (pending batons survive).
    expect(git(repo, ['rev-parse', `${HANDOFF_REF}^{tree}`]).stdout.trim()).toBe(treeBefore);
    expect(treeNames(repo, HANDOFF_REF)).toHaveLength(60);
    // history is cut to the retention window, locally and on the remote.
    expect(Number(git(repo, ['rev-list', '--count', HANDOFF_REF]).stdout.trim())).toBe(50);
    expect(git(origin, ['rev-parse', HANDOFF_REF]).stdout.trim()).toBe(refTip(repo) ?? 'MISSING');
    expect(Number(git(origin, ['rev-list', '--count', HANDOFF_REF]).stdout.trim())).toBe(50);
    // committer dates survive the rebuild (future retention windows stay correct).
    expect(git(repo, ['log', '-1', '--format=%cI', HANDOFF_REF]).stdout.trim()).toBe(tipDateBefore);
  }, 120_000);

  test('recent history within the 7-day window is NOT truncated even beyond 50 commits', async () => {
    const origin = await makeBareOrigin();
    const { repo } = await repoWithManyBatons(origin, 55);
    // real now: all 55 commits are minutes old → inside the 7-day window → keep all.
    const out = syncHandoffRef(repo, 'origin', opts());
    expect(out.status).toBe('pushed');
    expect(Number(git(repo, ['rev-list', '--count', HANDOFF_REF]).stdout.trim())).toBe(55);
  }, 120_000);

  test('stale local + remote-only pending baton: truncation fetches FIRST and the remote baton survives', async () => {
    // Sweep constraint: truncation cannot rely on a push rejection (force is not
    // rejected) — it must fetch + re-merge BEFORE rebuilding, absorbing batons
    // that exist only on the remote.
    const origin = await makeBareOrigin();
    const { repo } = await repoWithManyBatons(origin, 60);
    expect(syncHandoffRef(repo, 'origin', opts()).status).toBe('pushed');
    const b = await makeRepo(origin);
    const stemZ = otherPcPush(b, 'sess-zzz'); // remote-only pending baton; local is stale

    const out = syncHandoffRef(repo, 'origin', opts({ now: new Date(Date.now() + 8 * DAY) }));
    expect(out.status).toBe('nothing-to-push'); // nothing new locally — retention still ran
    expect(treeNames(origin, HANDOFF_REF)).toContain(`${stemZ}.md`);
    expect(Number(git(origin, ['rev-list', '--count', HANDOFF_REF]).stdout.trim())).toBe(50);
    // the remote baton's entry is reachable in the truncated history, not just the tree.
    expect(
      git(repo, ['log', HANDOFF_REF, '--format=%H', '--', `${stemZ}.md`]).stdout.trim().length,
    ).toBeGreaterThan(0);
  }, 120_000);

  test('concurrent write during truncation: lease failure → re-fetch → recompute → the racing baton survives', async () => {
    // ac-retention-invariant (concurrent-write case): a baton pushed by a second
    // fixture clone BETWEEN snapshot and force-with-lease causes a lease failure;
    // the truncation recomputes and the racing baton is reachable in new history.
    const origin = await makeBareOrigin();
    const { repo } = await repoWithManyBatons(origin, 60);
    const b = await makeRepo(origin);
    let raceStem = '';
    let fired = 0;

    const out = syncHandoffRef(
      repo,
      'origin',
      opts({
        now: new Date(Date.now() + 8 * DAY),
        hooks: {
          beforeForcePush: () => {
            if (fired > 0) return;
            fired += 1;
            raceStem = otherPcPush(b, 'sess-race');
          },
        },
      }),
    );
    expect(out.status).toBe('pushed');
    expect(fired).toBe(1);
    // the racing baton is on the truncated remote tip tree AND reachable in history.
    expect(treeNames(origin, HANDOFF_REF)).toContain(`${raceStem}.md`);
    expect(
      git(repo, ['log', HANDOFF_REF, '--format=%H', '--', `${raceStem}.md`]).stdout.trim().length,
    ).toBeGreaterThan(0);
    expect(git(origin, ['rev-parse', HANDOFF_REF]).stdout.trim()).toBe(refTip(repo) ?? 'MISSING');
  }, 120_000);

  test('post-truncation stale PC: unpushed baton is tree-replayed onto the new root, old history NOT reintroduced', async () => {
    // Sweep constraint: after a truncation force-push, a PC still on the OLD tip
    // must not wedge on non-FF, must not be reset (losing its unpushed baton),
    // and must not merge the cut history back in — tree-level replay only.
    const origin = await makeBareOrigin();
    const { repo: a } = await repoWithManyBatons(origin, 60);
    expect(syncHandoffRef(a, 'origin', opts()).status).toBe('pushed');
    const b = await makeRepo(origin);
    expect(git(b, ['fetch', 'origin', `+${HANDOFF_REF}:${HANDOFF_REF}`]).exitCode).toBe(0);
    const oldRoot = git(b, ['rev-list', '--max-parents=0', HANDOFF_REF]).stdout.trim();

    // A truncates (remote history is now UNRELATED to B's old chain).
    expect(syncHandoffRef(a, 'origin', opts({ now: new Date(Date.now() + 8 * DAY) })).status).toBe(
      'nothing-to-push',
    );
    expect(Number(git(origin, ['rev-list', '--count', HANDOFF_REF]).stdout.trim())).toBe(50);

    // B (old tip) writes an unpushed baton, then syncs against the truncated remote.
    const stemW = new HandoffRefStore(b).write(makeHandoff('sess-www'), { author: 'bob' }).stem;
    const out = syncHandoffRef(b, 'origin', opts());
    expect(out.status).toBe('pushed');
    // the unpushed baton SURVIVES on the remote…
    expect(treeNames(origin, HANDOFF_REF)).toContain(`${stemW}.md`);
    // …and every pre-truncation baton is still present in the tip tree (union).
    expect(treeNames(origin, HANDOFF_REF)).toHaveLength(61);
    // the old (cut) history was NOT reintroduced: old root unreachable from the new tip.
    expect(git(b, ['merge-base', '--is-ancestor', oldRoot, refTip(b) ?? '']).exitCode).not.toBe(0);
    expect(Number(git(origin, ['rev-list', '--count', HANDOFF_REF]).stdout.trim())).toBeLessThan(
      55,
    );
  }, 120_000);
});

// ─── pending-unpushed bookkeeping ─────────────────────────────────────────────

describe('pendingUnpushed', () => {
  test('reports pending after a local write, cleared after a successful sync', async () => {
    const origin = await makeBareOrigin();
    const repo = await makeRepo(origin);
    expect(pendingUnpushed(repo).pending).toBe(false); // unborn ref → nothing pending
    new HandoffRefStore(repo).write(makeHandoff('sess-p'), { author: 'alice' });
    expect(pendingUnpushed(repo).pending).toBe(true);
    expect(syncHandoffRef(repo, 'origin', opts()).status).toBe('pushed');
    const st = pendingUnpushed(repo);
    expect(st.pending).toBe(false);
    expect(st.lastPushed).toBe(refTip(repo) ?? 'MISSING');
    // the bookkeeping ref is itself a refs/ditto/* local ref — never pushed.
    expect(git(repo, ['rev-parse', '--verify', '--quiet', SYNC_PUSHED_REF]).exitCode).toBe(0);
    expect(git(origin, ['rev-parse', '--verify', '--quiet', SYNC_PUSHED_REF]).exitCode).not.toBe(0);
  });
});
