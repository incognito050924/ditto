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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listChangedFiles } from '~/core/git';

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
