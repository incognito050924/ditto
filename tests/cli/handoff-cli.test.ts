import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkItemStore } from '~/core/work-item-store';

/**
 * `ditto handoff` CLI (wi_260714xpw, node impl-cli-handoff-producer). The no-WI
 * SESSION/author-scope producer plus the EXPLICIT-PULL discovery/consume surface —
 * `ditto handoff [write]` → `ditto handoff list` → `ditto handoff consume <id>`. Spawns
 * the source CLI with cwd=<temp repo> so every write lands in an isolated tree (never
 * the real .ditto). The existing `ditto work handoff <id>` must keep working (ac-2/ac-6,
 * and the work_item scope round-trips through the SAME list/consume surface).
 */
const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const USAGE_ERROR_EXIT = 65;

let dir: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
}

function ditto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-handoff-cli-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto handoff — session/author-scope producer (ac-2)', () => {
  test('explicit --session write is read back by list + show + consume', () => {
    const w = ditto([
      'handoff',
      'write',
      '--session',
      'sess-alpha',
      '--intent',
      'ship the widget',
      '--from',
      'cli session A',
      '--state',
      'half done',
      '--next',
      'run bun test',
      '--output',
      'json',
    ]);
    expect(w.exitCode).toBe(0);
    const written = JSON.parse(w.stdout);
    expect(written.scope.kind).toBe('session');
    expect(written.scope.session_id).toBe('sess-alpha');
    expect(written.stem).toBe('session__sess-alpha');

    // list discovers the pending session handoff (ac-6 discovery).
    const l = ditto(['handoff', 'list', '--output', 'json']);
    expect(l.exitCode).toBe(0);
    const listed = JSON.parse(l.stdout);
    const entry = listed.active.find((a: { id: string }) => a.id === 'session__sess-alpha');
    expect(entry).toBeDefined();
    expect(entry.kind).toBe('session');

    // show is a read-only view (no marker, does not consume).
    const s = ditto(['handoff', 'show', 'session__sess-alpha', '--output', 'json']);
    expect(s.exitCode).toBe(0);
    expect(JSON.parse(s.stdout).body).toContain('ship the widget');

    // consume returns the body on-demand (ac-6 consume).
    const c = ditto(['handoff', 'consume', 'session__sess-alpha', '--output', 'json']);
    expect(c.exitCode).toBe(0);
    const consumed = JSON.parse(c.stdout);
    expect(consumed.body).toContain('half done');

    // ac-7 soft: consume did NOT move/delete the file — list still surfaces it.
    const l2 = ditto(['handoff', 'list', '--output', 'json']);
    expect(
      JSON.parse(l2.stdout).active.some((a: { id: string }) => a.id === 'session__sess-alpha'),
    ).toBe(true);
  });

  test('`ditto handoff write` (no --session) writes a generated session-scope handoff', () => {
    const w = ditto([
      'handoff',
      'write',
      '--intent',
      'x',
      '--from',
      'y',
      '--state',
      'z',
      '--next',
      'n',
      '--output',
      'json',
    ]);
    expect(w.exitCode).toBe(0);
    const written = JSON.parse(w.stdout);
    expect(written.scope.kind).toBe('session');
    expect(written.scope.session_id.length).toBeGreaterThan(0);
    // and it is discoverable.
    const l = ditto(['handoff', 'list', '--output', 'json']);
    expect(JSON.parse(l.stdout).active.some((a: { id: string }) => a.id === written.stem)).toBe(
      true,
    );
  });

  test('missing required content flags is a usage error (exit 65)', () => {
    const w = ditto(['handoff', 'write', '--session', 'sess-x', '--output', 'json']);
    expect(w.exitCode).toBe(USAGE_ERROR_EXIT);
  });
});

describe('ditto handoff — work_item scope round-trips through the same surface (ac-6)', () => {
  test('`ditto work handoff <id>` still works and its handoff lists + consumes', async () => {
    const wi = await new WorkItemStore(dir).create({
      title: 'direct fix',
      source_request: 'fix the thing',
      goal: 'the thing is fixed',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'the command exits 0', verdict: 'unverified', evidence: [] },
      ],
    });
    // existing command preserved: an unverified AC → partial → ACTIVE handoff.
    const h = ditto(['work', 'handoff', wi.id, '--output', 'json']);
    expect(h.exitCode).toBe(0);
    expect(JSON.parse(h.stdout).final_verdict).toBe('partial');

    // the SAME list surface discovers the work_item handoff.
    const l = ditto(['handoff', 'list', '--output', 'json']);
    expect(l.exitCode).toBe(0);
    const entry = JSON.parse(l.stdout).active.find((a: { id: string }) => a.id === wi.id);
    expect(entry).toBeDefined();
    expect(entry.kind).toBe('work_item');

    // consume by id loads the body on-demand.
    const c = ditto(['handoff', 'consume', wi.id, '--output', 'json']);
    expect(c.exitCode).toBe(0);
    expect(JSON.parse(c.stdout).body.length).toBeGreaterThan(0);
  });
});

describe('ditto handoff list — surfaces parse failures, never silently drops (ac-3)', () => {
  test('a malformed handoff file appears under failures', async () => {
    await mkdir(join(dir, '.ditto', 'local', 'handoff'), { recursive: true });
    await writeFile(
      join(dir, '.ditto', 'local', 'handoff', 'session__broken.md'),
      'this is not a valid handoff file\n',
    );
    const l = ditto(['handoff', 'list', '--output', 'json']);
    expect(l.exitCode).toBe(0);
    const listed = JSON.parse(l.stdout);
    expect(
      listed.failures.some((f: { path: string }) => f.path.includes('session__broken.md')),
    ).toBe(true);
  });
});

// WHY THIS BLOCK EXISTS (wi_260714xpw, fix review-handoff-redesign.fix.r0 · ac-4)
//
// The store implements the COMMITTED-REMOTE tier (writeRemote/listRemote/consumeRemote:
// a per-scope handoff committed on the work branch `.ditto/handoff/<stem>.md`, delivered
// on checkout) and it is unit-tested at the store, BUT it had ZERO CLI caller — so the
// redesign's central feature (a committed handoff that crosses machines via git, vs the
// old gitignored-local-only path) was UNREACHABLE from `ditto handoff`. These tests pin
// the CLI wiring end-to-end: `write --remote` COMMITS a git-tracked file, `list` SURFACES
// it as a remote entry, and `consume <id>` routes to the remote tier (per-recipient LOCAL
// marker, NO git delete/commit/push). They fail RED until handoff.ts routes to the store's
// remote methods.
describe('ditto handoff — committed-remote tier round-trips through the CLI (ac-4)', () => {
  const wiId = 'wi_remotecli01';
  let bare: string;

  beforeEach(async () => {
    // a born HEAD on the work branch so writeRemote commits (mirrors the store test's
    // initGitRepo — writeRemote refuses a detached/unborn HEAD).
    git(['checkout', '-q', '-b', `ditto/${wiId}`]);
    git(['commit', '-q', '--allow-empty', '-m', 'init']);
    // an upstream that must stay un-advanced — proves the CLI never auto-pushes.
    bare = await mkdtemp(join(tmpdir(), 'ditto-handoff-cli-bare-'));
    execFileSync('git', ['init', '--bare', '-q'], { cwd: bare });
    git(['remote', 'add', 'origin', bare]);
  });
  afterEach(async () => {
    await rm(bare, { recursive: true, force: true });
  });

  function gitOut(args: string[]): string {
    return execFileSync('git', args, { cwd: dir }).toString().trim();
  }

  test('write --remote commits a git-tracked file that list surfaces and consume marks (no push)', () => {
    const w = ditto([
      'handoff',
      'write',
      '--remote',
      '--session',
      'sess-remote',
      '--intent',
      'ship the committed-remote handoff',
      '--from',
      'cli session A',
      '--state',
      'committed-remote-state',
      '--next',
      'run bun test',
      '--output',
      'json',
    ]);
    expect(w.exitCode).toBe(0);
    const written = JSON.parse(w.stdout);
    // the producer committed to the REMOTE tier on the work branch (not the local store).
    expect(written.remote).toBe(true);
    expect(written.branch).toBe(`ditto/${wiId}`);
    expect(written.stem).toContain('session__sess-remote__');
    expect(written.path).toBe(`.ditto/handoff/${written.stem}.md`);

    // committed + git-tracked (delivered on checkout), NOT gitignored.
    expect(gitOut(['ls-files', written.path])).toBe(written.path);
    // exactly one new commit was added by the remote write (init → +1).
    expect(gitOut(['rev-list', '--count', 'HEAD'])).toBe('2');

    // list surfaces the committed-remote handoff under a distinct `remote` set.
    const l = ditto(['handoff', 'list', '--output', 'json']);
    expect(l.exitCode).toBe(0);
    const listed = JSON.parse(l.stdout);
    const rentry = listed.remote.find((r: { id: string }) => r.id === written.stem);
    expect(rentry).toBeDefined();
    expect(rentry.kind).toBe('session');

    // consume routes to the REMOTE tier: returns the body + writes a per-recipient LOCAL
    // marker, and does NOT git-delete/commit — the committed file stays tracked.
    const c = ditto(['handoff', 'consume', written.stem, '--output', 'json']);
    expect(c.exitCode).toBe(0);
    expect(JSON.parse(c.stdout).body).toContain('committed-remote-state');
    // no new commit for the marker (marker is a gitignored local file), file still tracked.
    expect(gitOut(['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(gitOut(['ls-files', written.path])).toBe(written.path);

    // per-recipient soft consume: the same recipient's next list excludes it.
    const l2 = ditto(['handoff', 'list', '--output', 'json']);
    expect(JSON.parse(l2.stdout).remote.some((r: { id: string }) => r.id === written.stem)).toBe(
      false,
    );

    // NO push: the upstream ref was never created/advanced.
    expect(() => gitOut(['rev-parse', '--verify', `origin/ditto/${wiId}`])).toThrow();
  });
});
