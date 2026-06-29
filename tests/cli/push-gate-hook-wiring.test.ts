import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileExists } from '~/core/hosts/shared';
import { PUSH_GATE_HOOK_MARKER, setup } from '~/core/setup';
import { teardown } from '~/core/teardown';
import type { RecipePushGate } from '~/schemas/recipe';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const HOOK_TEMPLATE = join(REPO_ROOT, 'resources', 'hooks', 'pre-push');
const NOW = new Date('2026-06-29T00:00:00.000Z');
const GATE: RecipePushGate = { protected_branches: ['main'], test_command: 'bun test' };

interface Env {
  resourcesDir: string;
  projectRoot: string;
  homeDir: string;
}

async function freshEnv(): Promise<Env> {
  const resourcesDir = await mkdtemp(join(tmpdir(), 'ditto-pgw-res-'));
  const projectRoot = await mkdtemp(join(tmpdir(), 'ditto-pgw-proj-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'ditto-pgw-home-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: projectRoot });
  return { resourcesDir, projectRoot, homeDir };
}

async function cleanup(e: Env): Promise<void> {
  await rm(e.resourcesDir, { recursive: true, force: true });
  await rm(e.projectRoot, { recursive: true, force: true });
  await rm(e.homeDir, { recursive: true, force: true });
}

describe('setup() push-gate hook stage', () => {
  test('recipe push_gate present → setup installs the pre-push hook', async () => {
    const e = await freshEnv();
    try {
      const result = await setup({
        ...e,
        now: NOW,
        host: 'claude-code',
        pushGate: GATE,
        hookTemplatePath: HOOK_TEMPLATE,
      });

      expect(result.pushGateHook?.status).toBe('installed');
      const hookPath = join(e.projectRoot, '.git', 'hooks', 'pre-push');
      expect(await fileExists(hookPath)).toBe(true);
      expect(await readFile(hookPath, 'utf8')).toContain(PUSH_GATE_HOOK_MARKER);
    } finally {
      await cleanup(e);
    }
  });

  test('no push_gate → hook stage is null, no pre-push written', async () => {
    const e = await freshEnv();
    try {
      const result = await setup({
        ...e,
        now: NOW,
        host: 'claude-code',
        hookTemplatePath: HOOK_TEMPLATE,
      });

      expect(result.pushGateHook ?? null).toBeNull();
      expect(await fileExists(join(e.projectRoot, '.git', 'hooks', 'pre-push'))).toBe(false);
    } finally {
      await cleanup(e);
    }
  });

  test('teardown() removes the hook setup installed', async () => {
    const e = await freshEnv();
    try {
      await setup({
        ...e,
        now: NOW,
        host: 'claude-code',
        pushGate: GATE,
        hookTemplatePath: HOOK_TEMPLATE,
      });
      const hookPath = join(e.projectRoot, '.git', 'hooks', 'pre-push');
      expect(await fileExists(hookPath)).toBe(true);

      const result = await teardown({
        resourcesDir: e.resourcesDir,
        projectRoot: e.projectRoot,
        homeDir: e.homeDir,
      });

      expect(result.pushGateHook.status).toBe('removed');
      expect(await fileExists(hookPath)).toBe(false);
    } finally {
      await cleanup(e);
    }
  });
});

describe('ditto setup headless recipe path (e2e — ac-5 wiring)', () => {
  test('a discovered recipe.yaml with push_gate installs the pre-push hook', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'ditto-pgw-e2e-proj-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'ditto-pgw-e2e-home-'));
    try {
      execFileSync('git', ['init', '-q', '.'], { cwd: projectRoot });
      // A checked-in recipe.yaml declaring a push_gate — discovered by setup.
      await writeFile(
        join(projectRoot, 'recipe.yaml'),
        'push_gate:\n  protected_branches:\n    - main\n  test_command: bun test\n',
      );

      // Run the REAL CLI headless. Isolated HOME/CODEX_HOME so GLOBAL_* resources
      // land in throwaway dirs, never the developer's real ~/.claude.
      const r = execFileSync(
        'bun',
        [join(REPO_ROOT, 'src', 'cli', 'index.ts'), 'setup', '--dir', projectRoot, '--yes'],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...process.env, HOME: fakeHome, CODEX_HOME: join(fakeHome, '.codex') },
        },
      );

      expect(r).toContain('push-gate hook: installed');
      const hookPath = join(projectRoot, '.git', 'hooks', 'pre-push');
      expect(await fileExists(hookPath)).toBe(true);
      expect(await readFile(hookPath, 'utf8')).toContain(PUSH_GATE_HOOK_MARKER);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});
