import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkItemStore } from '~/core/work-item-store';

/**
 * `ditto work handoff <id> --remote` (wi_260714xpw follow-up).
 *
 * WHY THIS TEST EXISTS
 *   The handoff redesign's PRIMARY case for a WORK_ITEM handoff is the committed-remote
 *   tier: a per-scope handoff committed on the work branch `.ditto/handoff/<stem>.md`,
 *   delivered on a fetch/checkout, NEVER pushed. The store's `writeRemote` already supports
 *   work_item scope, and the sibling `ditto handoff write --remote` drives it for SESSION
 *   scope — but the work_item producer `ditto work handoff <id>` had NO `--remote` verb, so
 *   that primary case was UNREACHABLE from the CLI (only the gitignored LOCAL write existed).
 *
 * WHAT IT PINS (the AC assertion)
 *   `ditto work handoff <id> --remote` produces a git-TRACKED committed handoff on the work
 *   branch `ditto/<wi>` (routed through the store's `writeRemote`) and NEVER pushes. It also
 *   pins the opt-in boundary: WITHOUT `--remote`, nothing is committed (default LOCAL path,
 *   unchanged). Fails RED until work.ts adds the flag + routes to `store.writeRemote`.
 *
 * Spawns the source CLI with cwd=<temp repo> so every write lands in an isolated tree.
 * Mirrors the temp-git-sandbox pattern of the session `write --remote` test
 * (tests/cli/handoff-cli.test.ts): a born HEAD on the work branch (writeRemote refuses a
 * detached/unborn HEAD), and an un-advanced bare upstream to prove no auto-push.
 */
const cliEntry = join(process.cwd(), 'src/cli/index.ts');

let dir: string;
let bare = '';

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
}
function gitOut(args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString().trim();
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
  dir = await mkdtemp(join(tmpdir(), 'ditto-work-handoff-remote-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (bare) {
    await rm(bare, { recursive: true, force: true });
    bare = '';
  }
});

describe('ditto work handoff <id> --remote — committed-remote work_item handoff (no push)', () => {
  test('--remote commits a git-tracked handoff on the work branch and never pushes', async () => {
    // Create the work item FIRST so we know its id, then check out its work branch
    // `ditto/<id>` — writeRemote for work_item scope refuses any other branch.
    const wi = await new WorkItemStore(dir).create({
      title: 'cross-machine continuation',
      source_request: 'hand off the in-progress work to another clone',
      goal: 'the next machine resumes with full context',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'resumes cleanly', verdict: 'unverified', evidence: [] },
      ],
    });
    git(['checkout', '-q', '-b', `ditto/${wi.id}`]);
    git(['commit', '-q', '--allow-empty', '-m', 'init']);
    const commitsBefore = Number(gitOut(['rev-list', '--count', 'HEAD']));
    // An upstream that must stay un-advanced — proves --remote never auto-pushes.
    bare = await mkdtemp(join(tmpdir(), 'ditto-work-handoff-remote-bare-'));
    execFileSync('git', ['init', '--bare', '-q'], { cwd: bare });
    git(['remote', 'add', 'origin', bare]);

    const h = ditto(['work', 'handoff', wi.id, '--remote', '--output', 'json']);
    expect(h.exitCode).toBe(0);
    const out = JSON.parse(h.stdout);
    // Routed to the REMOTE tier on the work branch (not just the gitignored local store).
    expect(out.remote).toBe(true);
    expect(out.branch).toBe(`ditto/${wi.id}`);
    expect(out.stem).toContain(`${wi.id}__`);
    expect(out.path).toBe(`.ditto/handoff/${out.stem}.md`);

    // The committed handoff is git-TRACKED (delivered on checkout), not gitignored.
    expect(gitOut(['ls-files', out.path])).toBe(out.path);
    // Exactly one new commit was added by the remote write (init → +1).
    expect(Number(gitOut(['rev-list', '--count', 'HEAD']))).toBe(commitsBefore + 1);

    // NO push: the upstream ref was never created/advanced (a separate user-gated act).
    expect(() => gitOut(['rev-parse', '--verify', `origin/ditto/${wi.id}`])).toThrow();
  });

  test('without --remote, nothing is committed on the branch (default local path, unchanged)', async () => {
    const wi = await new WorkItemStore(dir).create({
      title: 'local only',
      source_request: 'default local handoff',
      goal: 'g',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    git(['checkout', '-q', '-b', `ditto/${wi.id}`]);
    git(['commit', '-q', '--allow-empty', '-m', 'init']);
    const commitsBefore = Number(gitOut(['rev-list', '--count', 'HEAD']));

    const h = ditto(['work', 'handoff', wi.id, '--output', 'json']);
    expect(h.exitCode).toBe(0);
    const out = JSON.parse(h.stdout);
    expect(out.remote).toBeUndefined();
    // No committed handoff file, no new commit — the opt-in remote tier stays inert.
    expect(gitOut(['ls-files', '.ditto/handoff/'])).toBe('');
    expect(Number(gitOut(['rev-list', '--count', 'HEAD']))).toBe(commitsBefore);
  });
});
