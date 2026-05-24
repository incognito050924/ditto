import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexHostAdapter } from '~/core/hosts';

let dir: string;

function commandExists(command: string): boolean {
  try {
    execFileSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-codex-spawn-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('codex spawnRun smoke', () => {
  const smoke = commandExists('codex') ? test : test.skip;

  smoke('spawns codex and returns a completion result', async () => {
    const proc = await codexHostAdapter.spawnRun?.({
      repoRoot: dir,
      cwd: '.',
      profile: 'networked',
      args: ['--help'],
      env: { set: {}, unset: [] },
    });
    expect(proc?.entrypoint).toBe('codex');
    const completion = await proc?.completion;
    expect(typeof completion?.exit_code === 'number' || completion?.exit_code === null).toBe(true);
  });
});
