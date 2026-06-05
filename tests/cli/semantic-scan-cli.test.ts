import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// O7 (wi_260605de1) — `ditto semantic scan` over a real git diff: single change
// auto-seeds, zero is a no-op, multiple fail-closes (O1). This is the keystone
// that removes wi_260605sv1's manual --before/--after limitation.

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_semscan01';

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
const semanticFile = () => join(dir, '.ditto', 'work-items', WI, 'semantic-compatibility.json');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-semscan-'));
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
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto semantic scan', () => {
  test('single changed signature auto-seeds an unverified artifact', async () => {
    await writeFile(join(dir, 'src/user.ts'), 'export function getUser(id: string): User {}\n');
    const r = ditto(['semantic', 'scan', '--work-item', WI, '--base', 'HEAD']);
    expect(r.exitCode).toBe(0);
    const seed = JSON.parse(await readFile(semanticFile(), 'utf8'));
    expect(seed.verdict.semantic_safe).toBe('unverified');
    expect(seed.change).toEqual({
      before: 'getUser(id: string): User | null',
      after: 'getUser(id: string): User',
    });
  });

  test('no signature change is a no-op (body-only edit)', async () => {
    await writeFile(
      join(dir, 'src/user.ts'),
      'export function getUser(id: string): User | null { return null; }\n',
    );
    const r = ditto(['semantic', 'scan', '--work-item', WI, '--base', 'HEAD']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('no exported signature changes');
    expect(await Bun.file(semanticFile()).exists()).toBe(false);
  });

  test('multiple changed signatures fail-close (O1)', async () => {
    // Commit a second exported function so BOTH symbols exist at the base ref;
    // a change requires the symbol present before and after.
    await writeFile(join(dir, 'src/more.ts'), 'export function f(a: string): void {}\n');
    git(['add', 'src/more.ts']);
    git(['commit', '-m', 'add more']);
    // Change both signatures vs HEAD.
    await writeFile(join(dir, 'src/user.ts'), 'export function getUser(id: string): User {}\n');
    await writeFile(join(dir, 'src/more.ts'), 'export function f(a: number): void {}\n');
    const r = ditto(['semantic', 'scan', '--work-item', WI, '--base', 'HEAD']);
    expect(r.exitCode).toBe(65);
    expect(r.stderr).toContain('signature changes');
    expect(await Bun.file(semanticFile()).exists()).toBe(false);
  });

  test('--file narrows the scan to one path', async () => {
    await writeFile(join(dir, 'src/user.ts'), 'export function getUser(id: number): User {}\n');
    await writeFile(join(dir, 'src/more.ts'), 'export function f(a: number): void {}\n');
    const r = ditto([
      'semantic',
      'scan',
      '--work-item',
      WI,
      '--base',
      'HEAD',
      '--file',
      'src/user.ts',
    ]);
    expect(r.exitCode).toBe(0);
    const seed = JSON.parse(await readFile(semanticFile(), 'utf8'));
    expect(seed.change.after).toBe('getUser(id: number): User');
  });
});
