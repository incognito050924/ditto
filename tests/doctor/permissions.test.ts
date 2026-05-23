import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const cli = join(repoRoot, 'src', 'cli', 'index.ts');
let dir: string;

function run(args: string[]) {
  return Bun.spawnSync(['bun', 'run', cli, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-doctor-permissions-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('doctor permissions', () => {
  test('passes safe permission config', async () => {
    await cp(
      join(repoRoot, 'tests', 'fixtures', 'doctor', 'codex', 'permissions-safe'),
      join(dir, '.codex'),
      { recursive: true },
    );
    await cp(
      join(repoRoot, 'tests', 'fixtures', 'doctor', 'claude-code', 'permissions-safe'),
      join(dir, '.claude'),
      { recursive: true },
    );
    const proc = run(['doctor', 'permissions', '--output', 'json']);
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString()).dangerous_count).toBe(0);
  });

  test('detects dangerous permission config', async () => {
    await cp(
      join(repoRoot, 'tests', 'fixtures', 'doctor', 'codex', 'permissions-dangerous'),
      join(dir, '.codex'),
      { recursive: true },
    );
    await cp(
      join(repoRoot, 'tests', 'fixtures', 'doctor', 'claude-code', 'permissions-dangerous'),
      join(dir, '.claude'),
      { recursive: true },
    );
    const proc = run(['doctor', 'permissions', '--output', 'json']);
    expect(proc.exitCode).toBe(1);
    expect(
      JSON.parse(proc.stdout.toString()).findings.some(
        (finding: { label: string }) => finding.label === 'dangerous_mode',
      ),
    ).toBe(true);
  });
});
