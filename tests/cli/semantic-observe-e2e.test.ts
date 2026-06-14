import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// O2/O8 (wi_260605aw1 S2) — `ditto semantic observe` over real git + CodeQL:
// records changes to a NON-gated observation, and a re-run with an unchanged tree
// is skipped by fingerprint (no second CodeQL build).
//
//   CODEQL_E2E=1 CODEQL_BIN=~/.local/bin/codeql bun test tests/cli/semantic-observe-e2e.test.ts
const CODEQL_BIN = process.env.CODEQL_BIN ?? `${process.env.HOME}/.local/bin/codeql`;
const enabled = process.env.CODEQL_E2E === '1' && existsSync(CODEQL_BIN);
const d = enabled ? describe : describe.skip;

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_obscli001';

let dir: string;
const git = (args: string[]) =>
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
function ditto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], {
    cwd: dir,
    // Put the codeql dir on PATH so makeRelationDeps' `codeql` spawn resolves.
    env: { ...process.env, PATH: `${dirname(CODEQL_BIN)}:${process.env.PATH ?? ''}` },
  });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}
const obsFile = () =>
  join(dir, '.ditto', 'local', 'work-items', WI, 'semantic-scan-observation.json');

d('ditto semantic observe — real CodeQL', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-observe-'));
    await mkdir(join(dir, '.ditto'), { recursive: true });
    await mkdir(join(dir, 'src'), { recursive: true });
    git(['init']);
    git(['config', 'user.email', 't@t.t']);
    git(['config', 'user.name', 't']);
    await writeFile(
      join(dir, 'src/user.ts'),
      'export function getUser(id: string): User | null {}\n',
    );
    git(['add', '-A']);
    git(['commit', '-m', 'base']);
    await writeFile(join(dir, 'src/user.ts'), 'export function getUser(id: string): User {}\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('records the changed signature to a non-gated observation', async () => {
    const r = ditto([
      'semantic',
      'observe',
      '--work-item',
      WI,
      '--base',
      'HEAD',
      '--source-root',
      'src',
    ]);
    expect(r.exitCode).toBe(0);
    const obs = JSON.parse(await readFile(obsFile(), 'utf8'));
    expect(obs.kind).toBe('acg.semantic-scan-observation.v1');
    expect(obs.change_count).toBe(1);
    expect(obs.changes[0]).toMatchObject({
      file: 'user.ts',
      symbol: 'getUser',
      before: 'getUser(string): User | null',
      after: 'getUser(string): User',
    });
    // It must NOT write the blocking artifact (non-gated separation, O3).
    expect(
      existsSync(join(dir, '.ditto', 'local', 'work-items', WI, 'semantic-compatibility.json')),
    ).toBe(false);
  }, 120_000);

  test('a re-run with an unchanged tree is skipped by fingerprint', async () => {
    expect(
      ditto(['semantic', 'observe', '--work-item', WI, '--base', 'HEAD', '--source-root', 'src'])
        .exitCode,
    ).toBe(0);
    const r2 = ditto([
      'semantic',
      'observe',
      '--work-item',
      WI,
      '--base',
      'HEAD',
      '--source-root',
      'src',
    ]);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toContain('skipped');
  }, 120_000);
});
