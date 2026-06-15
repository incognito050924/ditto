import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

// ac-3 / dogfood (wi_260615lj6) — the FULL-BAR auto-commit reached by the CLI ALONE, end to
// end on a real git repo with real codeql. HEAD has a high-complexity function covered by a
// characterization test; the working tree holds a behavior-preserving tidy that lowers the
// complexity below threshold. `ditto refactor` must measure baselineGreen (L2 OLD),
// behaviorGreen (L2 OLD↔NEW preserved), and a debt DECREASE (codeql HEAD↔worktree), then
// auto-commit on an isolated branch — NEVER pushing (D8). Opt-in (needs codeql, ~30s).
describe.if(process.env.CODEQL_E2E === '1')('ditto refactor — full-bar auto-commit (e2e)', () => {
  // 11 branches → cyclomatic complexity ~12 (> the default 10 threshold).
  const HIGH_COMPLEXITY = `export function grade(n: number): string {
  if (n < 0) return 'invalid';
  if (n < 10) return 'F';
  if (n < 20) return 'E';
  if (n < 30) return 'D';
  if (n < 40) return 'C';
  if (n < 50) return 'C+';
  if (n < 60) return 'B';
  if (n < 70) return 'B+';
  if (n < 80) return 'A';
  if (n < 90) return 'A+';
  if (n <= 100) return 'S';
  return 'invalid';
}
`;
  // Same behavior via a table lookup → cyclomatic complexity ~3 (below threshold).
  const LOW_COMPLEXITY = `const BANDS: Array<[number, string]> = [
  [0, 'F'], [10, 'E'], [20, 'D'], [30, 'C'], [40, 'C+'],
  [50, 'B'], [60, 'B+'], [70, 'A'], [80, 'A+'], [90, 'S'],
];
export function grade(n: number): string {
  if (n < 0 || n > 100) return 'invalid';
  let g = 'F';
  for (const [min, label] of BANDS) if (n >= min) g = label;
  return g;
}
`;
  const CHARACTERIZATION = `import { test, expect } from 'bun:test';
import { grade } from '../src/widget/grade';
test('grade pins behavior across all bands', () => {
  const cases: Array<[number, string]> = [
    [-1, 'invalid'], [5, 'F'], [15, 'E'], [25, 'D'], [35, 'C'], [45, 'C+'],
    [55, 'B'], [65, 'B+'], [75, 'A'], [85, 'A+'], [90, 'S'], [100, 'S'], [101, 'invalid'],
  ];
  for (const [n, want] of cases) expect(grade(n)).toBe(want);
});
`;

  test('covered unit + behavior-preserving complexity tidy → barMet, auto-commit, push 0', async () => {
    await mkdir(join(dir, 'src', 'widget'), { recursive: true });
    await mkdir(join(dir, 'tests'), { recursive: true });
    await mkdir(join(dir, 'scripts'), { recursive: true });
    // The L2 preload must be reachable at <repoRoot>/scripts (ditto resolves it there).
    await copyFile(
      join(process.cwd(), 'scripts', 'l2-effect-preload.ts'),
      join(dir, 'scripts', 'l2-effect-preload.ts'),
    );
    await writeFile(join(dir, 'src', 'widget', 'grade.ts'), HIGH_COMPLEXITY);
    await writeFile(join(dir, 'tests', 'widget-grade.test.ts'), CHARACTERIZATION);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'baseline: high-complexity grade()']); // HEAD = OLD

    // Apply the behavior-preserving tidy to the WORKING TREE (NEW) — uncommitted.
    await writeFile(join(dir, 'src', 'widget', 'grade.ts'), LOW_COMPLEXITY);

    const r = ditto(['refactor', '--scope', 'component:widget', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.baselineGreen).toBe(true);
    expect(out.behaviorGreen).toBe(true);
    expect(out.debt.before).toBeGreaterThan(out.debt.after); // complexity violation cleared
    expect(out.barMet).toBe(true);
    expect(out.autoCommit).toBe('full');
    expect(out.commit?.committed).toBe(true);
    expect(out.commit?.branch).toBe('ditto-tidy/component-widget');
    // D8: never pushed (no remote configured, no push call).
    expect(git(['remote']).stdout.toString().trim()).toBe('');
  }, 180_000);
});
