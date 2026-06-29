import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileExists } from '~/core/hosts/shared';
import {
  PUSH_GATE_HOOK_BACKUP_SUFFIX,
  PUSH_GATE_HOOK_MARKER,
  installPushGateHook,
} from '~/core/setup';

// The real bundled template that `ditto setup` installs.
const HOOK_TEMPLATE = join(import.meta.dir, '..', '..', 'resources', 'hooks', 'pre-push');

async function freshGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-pushgate-hook-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  return dir;
}

/** POSIX exec bit on the installed hook (best-effort: Windows has no exec bit). */
async function isExecutable(path: string): Promise<boolean> {
  const mode = (await stat(path)).mode;
  return (mode & 0o111) !== 0;
}

describe('installPushGateHook', () => {
  test('clean repo: writes an executable ditto-managed pre-push hook', async () => {
    const repo = await freshGitRepo();
    try {
      const result = await installPushGateHook({
        projectRoot: repo,
        hookTemplatePath: HOOK_TEMPLATE,
      });

      expect(result.status).toBe('installed');
      expect(await fileExists(result.hookPath)).toBe(true);
      const body = await readFile(result.hookPath, 'utf8');
      expect(body).toContain(PUSH_GATE_HOOK_MARKER);
      expect(body).toContain('ditto');
      expect(await isExecutable(result.hookPath)).toBe(true);
      expect(result.backupPath).toBeNull();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('idempotent re-run: refreshes our hook in place, no second backup', async () => {
    const repo = await freshGitRepo();
    try {
      const first = await installPushGateHook({
        projectRoot: repo,
        hookTemplatePath: HOOK_TEMPLATE,
      });
      expect(first.status).toBe('installed');

      const second = await installPushGateHook({
        projectRoot: repo,
        hookTemplatePath: HOOK_TEMPLATE,
      });
      expect(second.status).toBe('refreshed');
      expect(second.backupPath).toBeNull();
      // No backup was created for our own hook.
      expect(await fileExists(`${second.hookPath}${PUSH_GATE_HOOK_BACKUP_SUFFIX}`)).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('existing non-ditto hook: backs it up (never clobbers) then installs ours', async () => {
    const repo = await freshGitRepo();
    try {
      const hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim();
      const userHook = join(repo, hooksDir, 'pre-push');
      await writeFile(userHook, '#!/bin/sh\necho USER HOOK\n');

      const result = await installPushGateHook({
        projectRoot: repo,
        hookTemplatePath: HOOK_TEMPLATE,
      });

      expect(result.status).toBe('backed-up');
      expect(result.backupPath).toBe(`${userHook}${PUSH_GATE_HOOK_BACKUP_SUFFIX}`);
      // The user's hook content survives in the backup.
      const backup = await readFile(`${userHook}${PUSH_GATE_HOOK_BACKUP_SUFFIX}`, 'utf8');
      expect(backup).toContain('USER HOOK');
      // Our hook is now the active pre-push.
      const active = await readFile(userHook, 'utf8');
      expect(active).toContain(PUSH_GATE_HOOK_MARKER);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('non-ditto hook AND a backup already present: refuses (no clobber)', async () => {
    const repo = await freshGitRepo();
    try {
      const hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim();
      const userHook = join(repo, hooksDir, 'pre-push');
      await writeFile(userHook, '#!/bin/sh\necho USER HOOK v2\n');
      await writeFile(`${userHook}${PUSH_GATE_HOOK_BACKUP_SUFFIX}`, '#!/bin/sh\necho OLD BACKUP\n');

      const result = await installPushGateHook({
        projectRoot: repo,
        hookTemplatePath: HOOK_TEMPLATE,
      });

      expect(result.status).toBe('refused-existing');
      expect(result.message).toBeTruthy();
      // The user's current hook is untouched.
      expect(await readFile(userHook, 'utf8')).toContain('USER HOOK v2');
      // The existing backup is NOT overwritten.
      expect(await readFile(`${userHook}${PUSH_GATE_HOOK_BACKUP_SUFFIX}`, 'utf8')).toContain(
        'OLD BACKUP',
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('custom core.hooksPath (husky/lefthook): refuses with guidance, installs nothing', async () => {
    const repo = await freshGitRepo();
    try {
      execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: repo });

      const result = await installPushGateHook({
        projectRoot: repo,
        hookTemplatePath: HOOK_TEMPLATE,
      });

      expect(result.status).toBe('refused-hookspath');
      expect(result.message).toContain('core.hooksPath');
      // Nothing was written into .git/hooks.
      expect(await fileExists(join(repo, '.git', 'hooks', 'pre-push'))).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('non-git directory: reports no-git-repo, writes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-pushgate-nogit-'));
    try {
      const result = await installPushGateHook({
        projectRoot: dir,
        hookTemplatePath: HOOK_TEMPLATE,
      });
      expect(result.status).toBe('no-git-repo');
      expect(result.message).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
