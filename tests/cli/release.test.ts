import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseGateError } from '~/cli/commands/release';

const repoRoot = join(import.meta.dir, '..', '..');
const cli = join(repoRoot, 'src', 'cli', 'index.ts');

describe('releaseGateError (pure precondition gate)', () => {
  test('refuses outside the ditto source repo, regardless of anything else', () => {
    expect(releaseGateError({ isSourceRepo: false, dirty: false, dryRun: false })).not.toBeNull();
    expect(releaseGateError({ isSourceRepo: false, dirty: false, dryRun: true })).not.toBeNull();
  });

  test('refuses a real release on a dirty tree', () => {
    expect(releaseGateError({ isSourceRepo: true, dirty: true, dryRun: false })).not.toBeNull();
  });

  test('allows a dry-run even on a dirty tree (it mutates nothing)', () => {
    expect(releaseGateError({ isSourceRepo: true, dirty: true, dryRun: true })).toBeNull();
  });

  test('allows a real release on a clean source-repo tree', () => {
    expect(releaseGateError({ isSourceRepo: true, dirty: false, dryRun: false })).toBeNull();
  });
});

describe('ditto release (CLI surface)', () => {
  test('--help exits 0 (subcommand registered)', () => {
    const proc = Bun.spawnSync(['bun', 'run', cli, 'release', '--help'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(0);
  });

  describe('outside the ditto source repo', () => {
    let consumer: string;

    beforeEach(async () => {
      // A consumer-like project: package.json name !== 'ditto', no src/cli — so
      // isDittoSourceRepo() is false. A .ditto marker lets resolveRepoRootForCreate
      // root here instead of walking up into the real repo.
      consumer = await mkdtemp(join(tmpdir(), 'ditto-release-consumer-'));
      await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'some-app' }));
      await mkdir(join(consumer, '.ditto'), { recursive: true });
    });

    afterEach(async () => {
      await rm(consumer, { recursive: true, force: true });
    });

    test('refuses (exit != 0) and mutates nothing', () => {
      const proc = Bun.spawnSync(['bun', 'run', cli, 'release', 'patch'], {
        cwd: consumer,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(proc.exitCode).not.toBe(0);
      expect(proc.stderr.toString()).toContain('release refused');
    });
  });

  test('--dry-run in the source repo exits 0 and leaves package.json version unchanged', async () => {
    const before = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version;
    const proc = Bun.spawnSync(['bun', 'run', cli, 'release', 'patch', '--dry-run'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const after = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version;
    expect(proc.exitCode).toBe(0);
    expect(after).toBe(before);
  });
});
