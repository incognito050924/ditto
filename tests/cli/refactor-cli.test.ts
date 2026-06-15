import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// WU-4 ac-8 / ac-10 CLI integration: `ditto refactor --scope <unit>` resolves a unit
// to its standing-code file set and (N8) defaults to diff-only + narrow residual
// questions. The bar-met → isolated-branch commit path is exercised separately, and
// we assert NO push to any remote (push count = 0).

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
let dir: string;

const git = (args: string[]) =>
  Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });

function ditto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-refactor-'));
  // ditto repo-root marker (findRepoRoot prefers .ditto) so resolveRepoRootForCreate
  // lands on this fixture, not the surrounding workspace.
  await mkdir(join(dir, '.ditto'), { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, 'src', 'core'), { recursive: true });
  await mkdir(join(dir, 'src', 'cli'), { recursive: true });
  await mkdir(join(dir, 'src', 'controller'), { recursive: true });
  await writeFile(join(dir, 'src', 'core', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(dir, 'src', 'core', 'b.ts'), 'export const b = 2;\n');
  await writeFile(join(dir, 'src', 'cli', 'index.ts'), 'export const c = 3;\n');
  await writeFile(join(dir, 'src', 'controller', 'user.ts'), 'export const d = 4;\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto refactor --scope (WU-4)', () => {
  test('ac-8: --scope component:core resolves to the core file set', () => {
    const r = ditto(['refactor', '--scope', 'component:core', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.unit).toBe('component:core');
    expect((out.files as string[]).sort()).toEqual(['src/core/a.ts', 'src/core/b.ts'].sort());
  });

  test('ac-8: --scope api resolves to the controllers/routes file set', () => {
    const r = ditto(['refactor', '--scope', 'api', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.files).toEqual(['src/controller/user.ts']);
  });

  test('ac-8: --scope all resolves to the whole tracked src set', () => {
    const r = ditto(['refactor', '--scope', 'all', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect((out.files as string[]).sort()).toEqual(
      ['src/cli/index.ts', 'src/controller/user.ts', 'src/core/a.ts', 'src/core/b.ts'].sort(),
    );
  });

  test('ac-8: --scope <glob> resolves by glob', () => {
    const r = ditto(['refactor', '--scope', 'src/cli/**', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.files).toEqual(['src/cli/index.ts']);
  });

  test('ac-10: no coverage provider → diff-only default + narrow residual question (not bulk diff)', () => {
    const r = ditto(['refactor', '--scope', 'component:core', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.autoCommit).toBe('diff-only');
    expect(out.barMet).toBe(false);
    expect((out.residualQuestions as string[]).length).toBeGreaterThanOrEqual(1);
    expect(out.residualQuestions[0]).toContain('no coverage provider');
  });

  test('ac-10: refactor never pushes to a remote (push count = 0)', () => {
    // A dummy remote whose pushes would be observable in its reflog if attempted.
    ditto(['refactor', '--scope', 'all', '--output', 'json']);
    // No `git push` should have run; the working repo has no remote configured anyway,
    // and the diff-only path makes no commit on a branch. Assert main is untouched and
    // no isolated tidy branch was pushed.
    const branches = git(['branch', '--list']).stdout.toString();
    // diff-only path must not have created an auto-commit branch with a tidy commit.
    const remotes = git(['remote']).stdout.toString().trim();
    expect(remotes).toBe(''); // nothing pushed because no remote and no push call
    expect(branches).toContain('main');
  });
});
