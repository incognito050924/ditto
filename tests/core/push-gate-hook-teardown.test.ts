import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileExists } from '~/core/hosts/shared';
import { PUSH_GATE_HOOK_MARKER, installPushGateHook } from '~/core/setup';
import { uninstallPushGateHook } from '~/core/teardown';

const HOOK_TEMPLATE = join(import.meta.dir, '..', '..', 'resources', 'hooks', 'pre-push');

async function freshGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-pushgate-td-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  return dir;
}

describe('uninstallPushGateHook', () => {
  test('removes our hook when there was no prior hook', async () => {
    const repo = await freshGitRepo();
    try {
      const installed = await installPushGateHook({
        projectRoot: repo,
        hookTemplatePath: HOOK_TEMPLATE,
      });
      expect(installed.status).toBe('installed');
      expect(await fileExists(installed.hookPath)).toBe(true);

      const result = await uninstallPushGateHook({ projectRoot: repo });

      expect(result.status).toBe('removed');
      expect(await fileExists(installed.hookPath)).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('restores the prior hook that install backed up', async () => {
    const repo = await freshGitRepo();
    try {
      const hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim();
      const userHook = join(repo, hooksDir, 'pre-push');
      await writeFile(userHook, '#!/bin/sh\necho USER PRIOR HOOK\n');

      const installed = await installPushGateHook({
        projectRoot: repo,
        hookTemplatePath: HOOK_TEMPLATE,
      });
      expect(installed.status).toBe('backed-up');

      const result = await uninstallPushGateHook({ projectRoot: repo });

      expect(result.status).toBe('restored-prior');
      // The user's prior hook is active again; our hook + backup are gone.
      const active = await readFile(userHook, 'utf8');
      expect(active).toContain('USER PRIOR HOOK');
      expect(active).not.toContain(PUSH_GATE_HOOK_MARKER);
      expect(result.backupPath).not.toBeNull();
      if (result.backupPath) expect(await fileExists(result.backupPath)).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('leaves a non-ditto hook untouched', async () => {
    const repo = await freshGitRepo();
    try {
      const hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim();
      const userHook = join(repo, hooksDir, 'pre-push');
      await writeFile(userHook, '#!/bin/sh\necho NOT OURS\n');

      const result = await uninstallPushGateHook({ projectRoot: repo });

      expect(result.status).toBe('left-untouched');
      expect(await readFile(userHook, 'utf8')).toContain('NOT OURS');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
