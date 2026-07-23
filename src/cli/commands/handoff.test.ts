import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HANDOFF_REF, HandoffRefStore } from '../../core/handoff-ref-store';
import { type Handoff, handoff as handoffSchema } from '../../schemas/handoff';
import { handoffCommand } from './handoff';

/**
 * Red-first unit tests for the `ditto handoff` CLI rewritten onto the hidden-ref
 * baton store (wi_260722g7h, g7h-impl-cli — ac-1 / ac-2 / ac-rewire).
 *
 * WHY these tests exist (AC map):
 *  - ac-1: `handoff write` must land the baton as a commit on refs/ditto/handoffs
 *    (worktree, current-branch history and `git branch` all untouched), and the
 *    NEW rich-field flags (--decision/--critical/--risk/--open/--forbid/
 *    --evidence/--changed) must round-trip into the existing schema fields —
 *    asserted by parsing the baton back off the ref, never by trusting stdout.
 *  - ac-2: `handoff consume` emits the body ONLY after the store's update-ref CAS
 *    succeeded, reports the deletion commit sha, and a second consume of the same
 *    stem gets the DISTINCT already-consumed refusal (exit 0) — different wording
 *    and exit code from a never-existed stem (exit 65). No-id resolution:
 *    exactly-one pending → auto-consume; several → list + exit 65 (no prompt).
 *  - ac-rewire (this file's slice): the command surface has NO `list` subcommand
 *    and NO import of the old two-tier file store (soft-consume markers, remote
 *    routing, --remote flag) — pinned by a source scan + the subcommand map.
 *  - defect wi_2607220o1 (cross-PC discovery): consume/show resolved pending
 *    batons from the LOCAL ref only — on a fresh clone they reported "no pending
 *    batons"/not_found even though origin's refs/ditto/handoffs held pending
 *    batons (they only appeared after some `write` ran, whose sync fetches
 *    first). The fix fetch-first-adopts BEFORE resolution; offline degrades to
 *    local-only resolution with the loud class-preserved warning (fetch is
 *    read-safe — never gated by the --push-public push-visibility gate), and a
 *    malformed baton still fails loudly without moving the ref tip.
 *
 * Fixtures mirror src/core/handoff-ref-sync.test.ts: throwaway tmpdir repos with
 * a `git init --bare` LOCAL origin — zero real network, zero real-forge URL.
 * Offline = origin URL pointing at a nonexistent path. Commands are driven by
 * calling the citty run() handlers directly; stdout/stderr/process.exit are
 * spied per invocation (exit throws a sentinel so exit codes are observable).
 */

const fixtures: string[] = [];
const origCwd = process.cwd();

afterEach(async () => {
  process.chdir(origCwd);
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

/** A bare local origin (never a real forge — the zero-network contract). */
async function makeBareOrigin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-handoffcli-origin-'));
  fixtures.push(dir);
  expect(git(dir, ['init', '--bare']).exitCode).toBe(0);
  return dir;
}

/** Plumbing helper for tests that must feed stdin (hash-object/mktree planting). */
function gitStdin(
  dir: string,
  args: string[],
  input: string,
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: new TextEncoder().encode(input),
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
  };
}

/**
 * A FRESH clone of the origin — the "another PC" fixture: `git clone` transfers
 * refs/heads/* only, so refs/ditto/handoffs is NOT carried over and no ditto
 * command has ever run here (the local hidden ref starts unborn).
 */
async function makeClone(originPath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-handoffcli-clone-'));
  fixtures.push(dir);
  expect(git(tmpdir(), ['clone', originPath, dir]).exitCode).toBe(0);
  expect(git(dir, ['config', 'user.email', 'fixture-b@example.invalid']).exitCode).toBe(0);
  expect(git(dir, ['config', 'user.name', 'FixtureB']).exitCode).toBe(0);
  return dir;
}

/** A throwaway work repo with one commit on `main` and `origin` → the given path. */
async function makeRepo(originPath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-handoffcli-'));
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

function refTip(dir: string): string | null {
  const r = git(dir, ['rev-parse', '--verify', '--quiet', `${HANDOFF_REF}^{commit}`]);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/** Baton built through the schema directly — the command file must not need the old store. */
function makeBaton(sessionId: string): Handoff {
  return handoffSchema.parse({
    schema_version: '0.1.0',
    scope: { kind: 'session', session_id: sessionId },
    from_context: 'fixture session',
    original_intent: 'carry the baton across sessions',
    current_state: 'mid-flight',
    next_first_check: 'read the baton body',
    created_at: new Date('2026-01-02T03:04:05.000Z').toISOString(),
  });
}

type RunHandler = (ctx: { args: Record<string, unknown> }) => Promise<void> | void;

function subCommands(): Record<string, { run?: RunHandler }> {
  return (handoffCommand as unknown as { subCommands: Record<string, { run?: RunHandler }> })
    .subCommands;
}

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/** Drive a subcommand run() handler; capture stdout/stderr and the exit code. */
async function runCmd(
  name: string,
  args: Record<string, unknown>,
): Promise<{ out: string; err: string; exitCode: number }> {
  const run = subCommands()[name]?.run;
  if (!run) throw new Error(`handoff subcommand '${name}' has no run handler`);
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const decode = (c: unknown): string =>
    typeof c === 'string' ? c : new TextDecoder().decode(c as Uint8Array);
  const so = spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
    outChunks.push(decode(c));
    return true;
  }) as unknown as typeof process.stdout.write);
  const se = spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => {
    errChunks.push(decode(c));
    return true;
  }) as unknown as typeof process.stderr.write);
  const ex = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(typeof code === 'number' ? code : 0);
  }) as unknown as typeof process.exit);
  let exitCode = 0;
  try {
    await run({ args });
  } catch (e) {
    if (e instanceof ExitSignal) exitCode = e.code;
    else throw e;
  } finally {
    so.mockRestore();
    se.mockRestore();
    ex.mockRestore();
  }
  return { out: outChunks.join(''), err: errChunks.join(''), exitCode };
}

/** The required write flags; rich fields / overrides layered per test. */
function writeFlags(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'ship the baton rewrite',
    from: 'unit-test session',
    state: 'cli rewrite under test',
    next: 'run the scoped tests',
    output: 'json',
    'push-public': true, // fixture origins resolve to 'unknown' visibility — explicit opt-in
    ...extra,
  };
}

describe('ac-rewire: old two-tier surface is gone from this command', () => {
  test('no `list` subcommand is registered (disambiguation output replaces it)', () => {
    const names = Object.keys(subCommands()).sort();
    expect(names).toEqual(['consume', 'purge', 'show', 'write']);
  });

  test('command source no longer touches the old file store (markers / remote routing / --remote)', () => {
    const src = readFileSync(join(import.meta.dir, 'handoff.ts'), 'utf8');
    expect(src).not.toContain('core/handoff-store');
    expect(src).not.toContain('consumeRemote');
    expect(src).not.toContain('listRemote');
    expect(src).not.toContain('consumeFor');
  });
});

describe('ac-1: handoff write → baton commit on the hidden ref, rich fields, clean worktree', () => {
  test('write lands a ref commit with rich fields recorded; worktree/branch/branch-list untouched; pushed to origin', async () => {
    const origin = await makeBareOrigin();
    const repo = await makeRepo(origin);
    process.chdir(repo);
    const headBefore = git(repo, ['rev-parse', 'HEAD']).stdout.trim();

    const res = await runCmd(
      'write',
      writeFlags({
        decision: ['chose the ref store', 'kept citty'],
        critical: 'hidden ref over branch::branch commits would pollute history',
        risk: 'pushed ref history::cannot be un-published from the remote',
        open: ['verify node still pending'],
        forbid: ['no core module edits'],
        evidence: ['bun test scoped run exit 0'],
        changed: ['src/cli/commands/handoff.ts'],
      }),
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.out) as { stem: string; commit: string; ref: string };
    expect(parsed.ref).toBe(HANDOFF_REF);
    expect(parsed.commit).toMatch(/^[0-9a-f]{40}$/);

    // The baton is a ref commit — nothing moved in the worktree or the branch.
    expect(refTip(repo)).toBe(parsed.commit);
    expect(git(repo, ['rev-parse', 'HEAD']).stdout.trim()).toBe(headBefore);
    expect(git(repo, ['status', '--porcelain', '-uno']).stdout.trim()).toBe('');
    expect(
      git(repo, ['for-each-ref', 'refs/heads', '--format=%(refname:short)']).stdout.trim(),
    ).toBe('main');

    // Rich fields round-trip: parse the baton back OFF THE REF.
    const baton = new HandoffRefStore(repo).list().batons.find((b) => b.stem === parsed.stem);
    expect(baton).toBeDefined();
    expect(baton?.handoff.decisions_made).toEqual(['chose the ref store', 'kept citty']);
    expect(baton?.handoff.critical_decisions).toEqual([
      { decision: 'hidden ref over branch', rationale: 'branch commits would pollute history' },
    ]);
    expect(baton?.handoff.irreversible_risks).toEqual([
      { risk: 'pushed ref history', why_irreversible: 'cannot be un-published from the remote' },
    ]);
    expect(baton?.handoff.open_threads).toEqual(['verify node still pending']);
    expect(baton?.handoff.forbidden_scope_creep).toEqual(['no core module edits']);
    expect(baton?.handoff.evidence_refs).toEqual([
      { kind: 'note', summary: 'bun test scoped run exit 0' },
    ]);
    expect(baton?.handoff.changed_files).toEqual(['src/cli/commands/handoff.ts']);

    // Sync fired (write triggers push): the LOCAL bare origin holds the ref.
    expect(git(origin, ['rev-parse', HANDOFF_REF]).stdout.trim()).toBe(parsed.commit);
  });

  test('write --work-item scopes the baton to the work item', async () => {
    const repo = await makeRepo(await makeBareOrigin());
    process.chdir(repo);
    const res = await runCmd('write', writeFlags({ 'work-item': 'wi_260722test' }));
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.out) as { stem: string };
    expect(parsed.stem.startsWith('wi_260722test__')).toBe(true);
  });

  test('malformed --critical pair (missing ::) is a usage error, exit 65', async () => {
    const repo = await makeRepo(await makeBareOrigin());
    process.chdir(repo);
    const res = await runCmd('write', writeFlags({ critical: 'no separator here' }));
    expect(res.exitCode).toBe(65);
    expect(res.err).toContain('--critical');
  });

  test('offline write: local ref commit succeeds with a loud class-preserved warning + pending-unpushed warning', async () => {
    const repo = await makeRepo(join(tmpdir(), `ditto-handoffcli-missing-${Date.now()}`));
    process.chdir(repo);
    const res = await runCmd('write', writeFlags());
    expect(res.exitCode).toBe(0);
    expect(refTip(repo)).not.toBeNull(); // local write survived the failed push
    expect(res.err).toContain("could not reach 'origin'"); // offline class preserved
    expect(res.err).toContain('NOT been pushed'); // repeated pending-unpushed warning
  });
});

describe('ac-2: handoff consume → body after CAS, deletion commit, first-consumer-wins', () => {
  test('consume returns the body, reports the deletion commit, and pushes the deletion', async () => {
    const origin = await makeBareOrigin();
    const repo = await makeRepo(origin);
    process.chdir(repo);
    const written = JSON.parse((await runCmd('write', writeFlags())).out) as { stem: string };

    const res = await runCmd('consume', {
      id: written.stem,
      output: 'json',
      'push-public': true,
    });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.out) as { id: string; deletion_commit: string; body: string };
    expect(parsed.id).toBe(written.stem);
    expect(parsed.deletion_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(parsed.body).toContain('# Handoff:');

    // Gone from the ref tip (per-repo → gone for every worktree), deletion pushed.
    expect(new HandoffRefStore(repo).list().batons).toHaveLength(0);
    const localTip = refTip(repo);
    expect(localTip).not.toBeNull();
    expect(git(origin, ['rev-parse', HANDOFF_REF]).stdout.trim()).toBe(localTip as string);
  });

  test('double consume → DISTINCT already-consumed message, exit 0 (not the not-found path)', async () => {
    const repo = await makeRepo(await makeBareOrigin());
    process.chdir(repo);
    const written = JSON.parse((await runCmd('write', writeFlags())).out) as { stem: string };
    expect((await runCmd('consume', { id: written.stem, 'push-public': true })).exitCode).toBe(0);

    const again = await runCmd('consume', { id: written.stem, 'push-public': true });
    expect(again.exitCode).toBe(0);
    expect(again.out).toContain('already consumed');
    expect(again.out).not.toContain('No handoff baton');
  });

  test('consume of a never-written stem → not-found message, exit 65', async () => {
    const repo = await makeRepo(await makeBareOrigin());
    process.chdir(repo);
    const res = await runCmd('consume', { id: 'session__never__nobody' });
    expect(res.exitCode).toBe(65);
    expect(res.err).toContain('No handoff baton');
  });

  test('consume with no id auto-resolves a single pending baton', async () => {
    const repo = await makeRepo(await makeBareOrigin());
    process.chdir(repo);
    const store = new HandoffRefStore(repo);
    const written = store.write(makeBaton('solo'));

    const res = await runCmd('consume', { output: 'json', 'push-public': true });
    expect(res.exitCode).toBe(0);
    expect((JSON.parse(res.out) as { id: string }).id).toBe(written.stem);
    expect(store.list().batons).toHaveLength(0);
  });

  test('consume with no id and multiple pending lists them and exits 65 (no prompt)', async () => {
    const repo = await makeRepo(await makeBareOrigin());
    process.chdir(repo);
    const store = new HandoffRefStore(repo);
    const one = store.write(makeBaton('one'));
    const two = store.write(makeBaton('two'));

    const res = await runCmd('consume', {});
    expect(res.exitCode).toBe(65);
    expect(res.out).toContain(one.stem);
    expect(res.out).toContain(two.stem);
    // Nothing was consumed by the ambiguous call.
    expect(store.list().batons).toHaveLength(2);
  });
});

describe('defect wi_2607220o1: consume/show fetch-first discovery of remote batons', () => {
  test('cross-PC: a fresh clone (no write ever ran) discovers and consumes a baton pushed from another repo', async () => {
    const origin = await makeBareOrigin();
    const repoA = await makeRepo(origin);
    process.chdir(repoA);
    const written = JSON.parse((await runCmd('write', writeFlags())).out) as { stem: string };
    expect(git(origin, ['rev-parse', HANDOFF_REF]).exitCode).toBe(0); // baton landed on origin

    // "Another PC": a fresh clone whose local refs/ditto/handoffs is UNBORN.
    const repoB = await makeClone(origin);
    process.chdir(repoB);
    expect(refTip(repoB)).toBeNull();

    // show must fetch-first-adopt origin's batons, not report the empty 0-state.
    const shown = await runCmd('show', { output: 'human' });
    expect(shown.exitCode).toBe(0);
    expect(shown.out).toContain(written.stem);
    expect(shown.out).toContain('# Handoff:');

    // consume must resolve the remote baton, deliver the body, and push the deletion.
    const consumed = await runCmd('consume', {
      id: written.stem,
      output: 'json',
      'push-public': true,
    });
    expect(consumed.exitCode).toBe(0);
    const parsed = JSON.parse(consumed.out) as { id: string; body: string };
    expect(parsed.id).toBe(written.stem);
    expect(parsed.body).toContain('# Handoff:');
    const localTip = refTip(repoB);
    expect(localTip).not.toBeNull();
    expect(git(origin, ['rev-parse', HANDOFF_REF]).stdout.trim()).toBe(localTip as string); // deletion pushed
  });

  test('offline consume: unreachable origin degrades to local-only resolution with the loud sync-failure warning', async () => {
    const repo = await makeRepo(join(tmpdir(), `ditto-handoffcli-missing-${Date.now()}`));
    process.chdir(repo);
    const written = new HandoffRefStore(repo).write(makeBaton('offline-consume'));

    const res = await runCmd('consume', { id: written.stem, output: 'json', 'push-public': true });
    expect(res.exitCode).toBe(0); // offline contract: local operations always succeed
    const parsed = JSON.parse(res.out) as { id: string; body: string };
    expect(parsed.id).toBe(written.stem);
    expect(parsed.body).toContain('# Handoff:');
    expect(res.err).toContain("could not reach 'origin'"); // class-preserved sync-failure warning
  });

  test('malformed baton (broken frontmatter) planted via plumbing: consume fails loudly, ref tip unchanged', async () => {
    const repo = await makeRepo(await makeBareOrigin());
    process.chdir(repo);
    // Plant a baton entry whose blob has NO frontmatter fence — bypassing the
    // store's write path exactly like a corrupted/foreign entry would.
    const blob = gitStdin(repo, ['hash-object', '-w', '--stdin'], 'not a baton\n').stdout.trim();
    const tree = gitStdin(
      repo,
      ['mktree', '-z'],
      `100644 blob ${blob}\tsession__broken__anon.md\0`,
    ).stdout.trim();
    const commit = git(repo, ['commit-tree', tree, '-m', 'plant broken baton']).stdout.trim();
    expect(git(repo, ['update-ref', HANDOFF_REF, commit]).exitCode).toBe(0);
    const tipBefore = refTip(repo);

    const res = await runCmd('consume', { id: 'session__broken__anon', 'push-public': true });
    expect(res.exitCode).not.toBe(0);
    expect(res.err).toContain('missing leading frontmatter fence'); // the parse error, surfaced
    expect(refTip(repo)).toBe(tipBefore); // no deletion commit landed
  });
});

describe('wi_260723tck: consume feeds the pre-resolution fetch observation into the deletion sync', () => {
  test('source wiring: consume forwards knownRemoteSha to the post-CAS sync (double-fetch removal)', () => {
    // The single-fetch elision itself is pinned in src/core/handoff-ref-sync.test.ts
    // ("the initial fetch is actually skipped"); at the CLI layer the contract is
    // the WIRING — the observed sha must reach syncHandoffRef's opts.
    const src = readFileSync(join(import.meta.dir, 'handoff.ts'), 'utf8');
    expect(src).toContain('knownRemoteSha');
  });

  test('online consume with a remote baton: the deletion commit lands on origin through the observed-sha path', async () => {
    const origin = await makeBareOrigin();
    const repo = await makeRepo(origin);
    process.chdir(repo);
    const written = JSON.parse((await runCmd('write', writeFlags())).out) as { stem: string };
    // Origin holds the baton — consume's pre-resolution fetch observes status
    // 'fetched' and its sha becomes knownRemoteSha for the deletion sync.
    expect(git(origin, ['rev-parse', HANDOFF_REF]).exitCode).toBe(0);

    const res = await runCmd('consume', { id: written.stem, output: 'json', 'push-public': true });
    expect(res.exitCode).toBe(0);
    const localTip = refTip(repo);
    expect(localTip).not.toBeNull();
    expect(git(origin, ['rev-parse', HANDOFF_REF]).stdout.trim()).toBe(localTip as string);
    expect(new HandoffRefStore(repo).list().batons).toHaveLength(0);
  });

  test('remote-unborn observation (knownRemoteSha = null): the deletion push still lands the ref on origin', async () => {
    const origin = await makeBareOrigin();
    const repo = await makeRepo(origin);
    process.chdir(repo);
    // Written through the STORE (no sync): origin never saw the handoff ref, so
    // the pre-resolution fetch observes 'remote-unborn' → knownRemoteSha null.
    const written = new HandoffRefStore(repo).write(makeBaton('unborn-remote'));
    expect(git(origin, ['rev-parse', '--verify', '--quiet', HANDOFF_REF]).exitCode).not.toBe(0);

    const res = await runCmd('consume', { id: written.stem, output: 'json', 'push-public': true });
    expect(res.exitCode).toBe(0);
    expect((JSON.parse(res.out) as { body: string }).body).toContain('# Handoff:');
    // The null observation elides the initial fetch but NOT the push: the
    // deletion tip is finalized on origin within the same command.
    const localTip = refTip(repo);
    expect(localTip).not.toBeNull();
    expect(git(origin, ['rev-parse', HANDOFF_REF]).stdout.trim()).toBe(localTip as string);
  });
});

describe('handoff purge: secret-recall history rewrite (wi_260723xh7)', () => {
  test('purge rewrites local+remote history to a single root; pending batons survive (tip tree preserved); exit 0', async () => {
    const origin = await makeBareOrigin();
    const repo = await makeRepo(origin);
    process.chdir(repo);
    // Two writes → multi-commit ref history on both local and origin.
    await runCmd('write', writeFlags({ session: 'first' }));
    const second = JSON.parse((await runCmd('write', writeFlags({ session: 'second' }))).out) as {
      stem: string;
    };
    expect(Number(git(repo, ['rev-list', '--count', HANDOFF_REF]).stdout.trim())).toBeGreaterThan(
      1,
    );

    const res = await runCmd('purge', { output: 'json', 'push-public': true });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.out) as { status: string; detail: string; warnings: string[] };
    expect(parsed.status).toBe('purged');
    expect(parsed.detail).toContain('single root');

    // Local history is a single parentless root; remote tip agrees (lease-push landed).
    const localTip = refTip(repo);
    expect(localTip).not.toBeNull();
    expect(git(repo, ['rev-list', '--count', HANDOFF_REF]).stdout.trim()).toBe('1');
    expect(git(origin, ['rev-parse', HANDOFF_REF]).stdout.trim()).toBe(localTip as string);
    // Truncation never touches the tip TREE: the pending batons are still there.
    const stems = new HandoffRefStore(repo).list().batons.map((b) => b.stem);
    expect(stems).toContain(second.stem);
    expect(stems).toHaveLength(2);
  });

  test('purge with an unborn ref → nothing-to-purge, exit 0 (idempotent no-op)', async () => {
    const repo = await makeRepo(await makeBareOrigin());
    process.chdir(repo);
    const res = await runCmd('purge', { 'push-public': true });
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain('Nothing to purge');
  });

  test('without --push-public on an unknown-visibility remote → refused, hint, exit 65', async () => {
    const repo = await makeRepo(await makeBareOrigin());
    process.chdir(repo);
    new HandoffRefStore(repo).write(makeBaton('refused'));
    const res = await runCmd('purge', {});
    expect(res.exitCode).toBe(65);
    expect(res.err).toContain('purge push refused');
    expect(res.err).toContain('--push-public');
    // Nothing was rewritten or pushed by the refused call.
    expect(new HandoffRefStore(repo).list().batons).toHaveLength(1);
  });

  test('secret-shaped content in the tip tree → scrub-refused, exit 65, ref tip unchanged', async () => {
    const origin = await makeBareOrigin();
    const repo = await makeRepo(origin);
    process.chdir(repo);
    // Plant a baton blob carrying a PAT-shaped token via plumbing (the store's
    // write path scrubs, so a leaked-token state can only be planted this way).
    const secret = `token ghp_${'aB3'.repeat(12)} leaked`;
    const blob = gitStdin(repo, ['hash-object', '-w', '--stdin'], `${secret}\n`).stdout.trim();
    const tree = gitStdin(
      repo,
      ['mktree', '-z'],
      `100644 blob ${blob}\tsession__dirty__anon.md\0`,
    ).stdout.trim();
    const commit = git(repo, ['commit-tree', tree, '-m', 'plant dirty baton']).stdout.trim();
    expect(git(repo, ['update-ref', HANDOFF_REF, commit]).exitCode).toBe(0);
    const tipBefore = refTip(repo);

    const res = await runCmd('purge', { 'push-public': true });
    expect(res.exitCode).toBe(65);
    expect(res.err).toContain('secret-shaped');
    expect(refTip(repo)).toBe(tipBefore); // dirty tree was never purge-pushed
    expect(git(origin, ['rev-parse', '--verify', '--quiet', HANDOFF_REF]).exitCode).not.toBe(0);
  });

  test('unreachable origin → failed, exit 1 (purge requires the remote)', async () => {
    const repo = await makeRepo(join(tmpdir(), `ditto-handoffcli-missing-${Date.now()}`));
    process.chdir(repo);
    new HandoffRefStore(repo).write(makeBaton('offline-purge'));
    const res = await runCmd('purge', { 'push-public': true });
    expect(res.exitCode).toBe(1);
    expect(res.err).toContain('purge requires the remote');
  });

  test('no origin remote → usage error, exit 65', async () => {
    const repo = await makeRepo(await makeBareOrigin());
    expect(git(repo, ['remote', 'remove', 'origin']).exitCode).toBe(0);
    process.chdir(repo);
    const res = await runCmd('purge', { 'push-public': true });
    expect(res.exitCode).toBe(65);
    expect(res.err).toContain('handoff purge requires an origin remote');
  });
});

describe('handoff show: read-only peek', () => {
  test('show prints the body without a deletion commit or any marker', async () => {
    const repo = await makeRepo(await makeBareOrigin());
    process.chdir(repo);
    const store = new HandoffRefStore(repo);
    const written = store.write(makeBaton('peek'));
    const tipBefore = refTip(repo);

    const res = await runCmd('show', { id: written.stem, output: 'human' });
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain('# Handoff:');
    expect(refTip(repo)).toBe(tipBefore); // no deletion commit
    expect(store.list().batons.map((b) => b.stem)).toEqual([written.stem]); // still pending
  });
});
