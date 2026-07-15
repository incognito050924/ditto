/**
 * listChangedFiles untracked-only baseline parsing (wi_260710s4j, n2 frozen-red).
 *
 * BACKGROUND — why these tests exist:
 * autopilot's `changed_files` over-includes FOREIGN untracked dirt that was already
 * lying in the working tree when the run started (a sibling session's `.ditto/…`
 * scratch, an unrelated new file). The fix captures an untracked-only baseline at
 * run start (draft→in_progress) and excludes those paths later. That baseline is
 * derived from `git status --porcelain`, so `listChangedFiles` must gain an
 * `untrackedOnly` mode that:
 *   1. returns ONLY the untracked (`??`) cohort — a tracked-but-modified file is
 *      in-scope work, never foreign dirt, so it must not enter the baseline;
 *   2. preserves git's COLLAPSED whole-untracked-directory entry (`.ditto/work-items/
 *      wi_x/` with a trailing slash) verbatim — the baseline stores that collapsed
 *      form and the later exclusion exact-matches it;
 *   3. NORMALIZES git's C-quoted non-ASCII porcelain path (`"\355\225\234…"`) back to
 *      the real utf-8 name, so the baseline compares equal to the utf-8 path an owner
 *      later reports.
 *
 * These are RED until `listChangedFiles` learns `untrackedOnly` — today the option is
 * ignored, so every changed line (tracked-dirty + raw-quoted) leaks through.
 *
 * Real temp git repos (not mocks): `listChangedFiles` IS the git wrapper, so its unit
 * is a real `git status --porcelain` over controlled fixtures. quotepath is forced on
 * so the non-ASCII fixture is deterministic regardless of global git config.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LAND_PUSH_TIMEOUT_MS,
  LAND_RECOVERY_TIMEOUT_MS,
  classifyPushRejection,
  landBranchToOrigin,
  listChangedFiles,
} from '~/core/git';

let repo: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-git-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  // Force the git default so the non-ASCII fixture is C-quoted deterministically.
  git(['config', 'core.quotepath', 'true']);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('listChangedFiles untrackedOnly baseline parsing (wi_260710s4j)', () => {
  test('returns only untracked (??) paths, excluding tracked-but-modified files', async () => {
    await writeFile(join(repo, 'tracked.txt'), 'x');
    git(['add', 'tracked.txt']);
    git(['commit', '-q', '-m', 'add tracked']);
    await writeFile(join(repo, 'tracked.txt'), 'x-modified'); // tracked-dirty (` M`)
    await writeFile(join(repo, 'untracked.ts'), 'new'); // untracked (`??`)

    // untrackedOnly keeps only the `??` cohort — the tracked-dirty file is in-scope
    // work, never foreign baseline dirt.
    expect(listChangedFiles(repo, { untrackedOnly: true })).toEqual(['untracked.ts']);
    // sanity: the default (all changes) DOES include the tracked-dirty file, so the
    // assertion above is exercising the filter, not an empty working tree.
    expect(listChangedFiles(repo)).toContain('tracked.txt');
  });

  test('preserves a collapsed whole-untracked-directory entry (trailing slash)', async () => {
    // Track the PARENT so only the new leaf dir is untracked → git collapses it to a
    // single `.ditto/work-items/wi_x/` porcelain entry.
    await mkdir(join(repo, '.ditto', 'work-items'), { recursive: true });
    await writeFile(join(repo, '.ditto', 'work-items', '.gitkeep'), 'k');
    git(['add', '.ditto/work-items/.gitkeep']);
    git(['commit', '-q', '-m', 'track parent']);
    await writeFile(join(repo, 'tracked.txt'), 'x');
    git(['add', 'tracked.txt']);
    git(['commit', '-q', '-m', 'add tracked']);
    await writeFile(join(repo, 'tracked.txt'), 'x-modified'); // tracked-dirty
    await mkdir(join(repo, '.ditto', 'work-items', 'wi_x'), { recursive: true });
    await writeFile(join(repo, '.ditto', 'work-items', 'wi_x', 'record.json'), 'z'); // untracked leaf

    // Only the collapsed untracked dir survives — the tracked-dirty file is filtered
    // out AND the collapsed form is preserved verbatim (not expanded to the leaf file).
    expect(listChangedFiles(repo, { untrackedOnly: true })).toEqual(['.ditto/work-items/wi_x/']);
  });

  test('dequotes a C-quoted non-ASCII untracked path back to its real utf-8 name', async () => {
    await writeFile(join(repo, '한글.txt'), 'a'); // porcelain C-quotes this by default

    // Normalized back to the real utf-8 path — the raw `"\355\225\234…"` quoted form
    // must not leak (the later exclusion compares against the utf-8 owner-reported path).
    expect(listChangedFiles(repo, { untrackedOnly: true })).toEqual(['한글.txt']);
  });
});

// ─── Direct-to-origin land (wi_2607156f8) ────────────────────────────────────
// BACKGROUND — why these tests exist:
// The worktree LAND path must push a work-item branch's commits STRAIGHT to
// origin/<default> (never a local merge into the shared main checkout). These pin:
//   C5  classifyPushRejection maps git's rejection wording to the retry-vs-surface
//       class (non-FF is recoverable; push-gate / auth-network are real failures).
//   C1/C2 landBranchToOrigin: a fast-forward push LANDS; a non-fast-forward
//       rejection is recovered by fetch+rebase (LINEAR, no merge commit)+re-push;
//       a rebase CONFLICT aborts (leaving a clean tree) and surfaces 'rebase-conflict';
//       a persistently-rejecting remote EXHAUSTS the bounded retry.
// Real temp git repos with a LOCAL bare "origin" (no network): landBranchToOrigin IS
// the git wrapper, so its unit is real `git push/fetch/rebase` over controlled fixtures.

describe('classifyPushRejection (C5 rejection classes)', () => {
  test("a non-fast-forward '[rejected] (fetch first)' rejection → non-ff (recoverable)", () => {
    const stderr =
      ' ! [rejected]        ditto/wi_x -> main (fetch first)\n' +
      "error: failed to push some refs to 'origin'";
    expect(classifyPushRejection(stderr)).toBe('non-ff');
    expect(classifyPushRejection('hint: Updates were rejected (non-fast-forward)')).toBe('non-ff');
  });

  test("a DITTO pre-push gate decline ('push-gate:') → push-gate (real failure)", () => {
    expect(classifyPushRejection('push-gate: `bun test` failed — push blocked.')).toBe('push-gate');
  });

  test('an auth/network rejection → auth-network (real failure)', () => {
    expect(classifyPushRejection('fatal: Authentication failed for https://host/x')).toBe(
      'auth-network',
    );
    expect(classifyPushRejection('fatal: could not read from remote repository')).toBe(
      'auth-network',
    );
  });
});

// ─── C2 land-timeout regression (wi_2607156f8 review — HIGH) ─────────────────
// BACKGROUND — why these tests exist:
// The land push fires the pre-push gate (a full `bun test`, minutes long; the push-gate
// force-kills a hung suite at its own ~10-min internal budget). An earlier fix capped
// EVERY land subprocess at 120_000 ms, which SIGTERM'd the gate-running push MID-GATE,
// before the ref update — so a would-be-successful land timed out and was misclassified as
// a hung/non-FF attempt → non-ff-retry-exhausted (a normal land could NEVER complete, and
// a real success looked like a failure). The fix splits the bound: the gate-running PUSH
// gets a budget that comfortably exceeds the gate, while the pure fetch/rebase RECOVERY
// steps (no gate) keep the shorter fail-fast bound — that is where the hung-subprocess
// protection actually belongs. These pin the invariant so the too-short cap can't recur.
describe('land timeouts (C2 regression: push clears the gate, recovery stays fast)', () => {
  // A realistic full-suite pre-push gate runs for minutes; the push-gate's own internal
  // timeout is ~10 min. The land push must clear that floor with margin.
  const GATE_FLOOR_MS = 600_000;
  test('the land PUSH timeout comfortably exceeds a realistic pre-push gate', () => {
    expect(LAND_PUSH_TIMEOUT_MS).toBeGreaterThanOrEqual(GATE_FLOOR_MS);
  });
  test('the pure fetch/rebase RECOVERY timeout stays shorter (fast-fail a genuine hang)', () => {
    expect(LAND_RECOVERY_TIMEOUT_MS).toBeLessThan(LAND_PUSH_TIMEOUT_MS);
  });
});

describe('landBranchToOrigin (C1/C2 push + non-FF recovery)', () => {
  let origin: string;
  let work: string;

  async function initOrigin(): Promise<void> {
    origin = await mkdtemp(join(tmpdir(), 'ditto-land-origin-'));
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { encoding: 'utf8' });
  }
  function g(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }
  async function seedOriginWithMain(): Promise<void> {
    const seed = await mkdtemp(join(tmpdir(), 'ditto-land-seed-'));
    execFileSync('git', ['clone', '-q', origin, seed], { encoding: 'utf8' });
    g(seed, ['config', 'user.email', 't@t']);
    g(seed, ['config', 'user.name', 't']);
    await writeFile(join(seed, 'shared.txt'), 'line1\n');
    g(seed, ['add', '.']);
    g(seed, ['commit', '-q', '-m', 'base']);
    g(seed, ['push', '-q', 'origin', 'main']);
    await rm(seed, { recursive: true, force: true });
  }
  /** A work clone on branch `ditto/wi_x`, forked from origin/main. */
  async function makeWork(): Promise<void> {
    work = await mkdtemp(join(tmpdir(), 'ditto-land-work-'));
    execFileSync('git', ['clone', '-q', origin, work], { encoding: 'utf8' });
    g(work, ['config', 'user.email', 't@t']);
    g(work, ['config', 'user.name', 't']);
    g(work, ['checkout', '-q', '-b', 'ditto/wi_x']);
  }
  /** Advance origin/main out-of-band (another clone) to force a non-FF on work's push. */
  async function advanceOriginMain(content: string, file = 'other.txt'): Promise<void> {
    const other = await mkdtemp(join(tmpdir(), 'ditto-land-other-'));
    execFileSync('git', ['clone', '-q', origin, other], { encoding: 'utf8' });
    g(other, ['config', 'user.email', 't@t']);
    g(other, ['config', 'user.name', 't']);
    await writeFile(join(other, file), content);
    g(other, ['add', '.']);
    g(other, ['commit', '-q', '-m', 'other-side change']);
    g(other, ['push', '-q', 'origin', 'main']);
    await rm(other, { recursive: true, force: true });
  }

  beforeEach(async () => {
    await initOrigin();
    await seedOriginWithMain();
    await makeWork();
  });
  afterEach(async () => {
    await rm(origin, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test('a fast-forward push LANDS the branch commits on origin/main', async () => {
    await writeFile(join(work, 'g.txt'), 'mywork\n');
    g(work, ['add', '.']);
    g(work, ['commit', '-q', '-m', 'my work']);
    const tip = g(work, ['rev-parse', 'HEAD']);

    const res = landBranchToOrigin(work, 'ditto/wi_x', 'main');
    expect(res.status).toBe('landed');
    // origin/main now holds the branch tip (the push updated the tracking ref).
    expect(g(work, ['rev-parse', 'refs/remotes/origin/main'])).toBe(tip);
  });

  test('a NON-fast-forward push is recovered by fetch+rebase (linear) then lands', async () => {
    await writeFile(join(work, 'g.txt'), 'mywork\n'); // non-conflicting new file
    g(work, ['add', '.']);
    g(work, ['commit', '-q', '-m', 'my work']);
    await advanceOriginMain('other\n'); // origin/main moves ahead → work's push is non-FF

    const res = landBranchToOrigin(work, 'ditto/wi_x', 'main');
    expect(res.status).toBe('landed');
    // origin/main contains BOTH the other-side commit AND the rebased branch commit,
    // and the history is LINEAR (no merge commit) — the branch was rebased, not merged.
    g(work, ['fetch', '-q', 'origin', 'main']);
    const graph = g(work, ['log', '--oneline', 'refs/remotes/origin/main']);
    expect(graph).toContain('my work');
    expect(graph).toContain('other-side change');
    const merges = g(work, ['rev-list', '--merges', 'refs/remotes/origin/main']);
    expect(merges).toBe(''); // no merge commit anywhere on the landed history
  });

  test('a rebase CONFLICT during non-FF recovery aborts (clean tree) and surfaces rebase-conflict', async () => {
    await writeFile(join(work, 'shared.txt'), 'branch-change\n'); // edits the SAME file…
    g(work, ['add', '.']);
    g(work, ['commit', '-q', '-m', 'branch edit']);
    await advanceOriginMain('base-change\n', 'shared.txt'); // …origin edits it too → rebase conflict

    const res = landBranchToOrigin(work, 'ditto/wi_x', 'main');
    expect(res.status).toBe('rebase-conflict');
    expect(res.reason).toContain('CONFLICT');
    // rebase --abort ran: the working tree is clean and HEAD is back on the branch.
    expect(g(work, ['status', '--porcelain'])).toBe('');
    expect(g(work, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('ditto/wi_x');
  });

  test('a persistently-rejecting remote EXHAUSTS the bounded retry (non-ff-retry-exhausted)', async () => {
    // A pre-receive hook that ALWAYS rejects with a non-FF marker makes every re-push
    // (after fetch+rebase) fail the same way → the bounded retry exhausts rather than
    // looping forever.
    const hook = join(origin, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\necho "fetch first" >&2\nexit 1\n');
    await chmod(hook, 0o755);
    await writeFile(join(work, 'g.txt'), 'mywork\n');
    g(work, ['add', '.']);
    g(work, ['commit', '-q', '-m', 'my work']);

    const res = landBranchToOrigin(work, 'ditto/wi_x', 'main', { maxRetries: 2 });
    expect(res.status).toBe('non-ff-retry-exhausted');
  });
});
