import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const cli = join(repoRoot, 'src', 'cli', 'index.ts');

describe('hook command', () => {
  test('rejects an unknown --host instead of falling back to claude-code', () => {
    const proc = Bun.spawnSync(['bun', 'run', cli, 'hook', 'pre-tool-use', '--host', 'codx'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain('invalid --host codx');
  });
});
