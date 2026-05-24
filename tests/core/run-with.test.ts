import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type HostAdapter,
  codexHostAdapter,
  registerHostAdapter,
  unregisterHostAdapter,
} from '~/core/hosts';
import { RunStore } from '~/core/run-store';
import { runWithProvider } from '~/core/run-with';
import { WorkItemStore } from '~/core/work-item-store';

let dir: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

async function commitAll(message: string): Promise<void> {
  git(['add', '.']);
  git(['commit', '-m', message]);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-run-with-'));
  git(['init']);
  git(['config', 'user.email', 'ditto@example.test']);
  git(['config', 'user.name', 'DITTO Test']);
  await writeFile(join(dir, 'README.md'), 'before\n', 'utf8');
  await mkdir(join(dir, '.ditto'), { recursive: true });
  await commitAll('initial');
});

afterEach(async () => {
  unregisterHostAdapter('codex');
  registerHostAdapter(codexHostAdapter);
  await rm(dir, { recursive: true, force: true });
});

function baseAdapter(): Omit<HostAdapter, 'id' | 'spawnRun'> {
  return {
    async loadInstructions() {
      return { role: 'source', host: 'codex', path: 'AGENTS.md', exists: false };
    },
    async loadPermissions() {
      return [{ host: 'codex', source_file: '.codex/config.toml', status: 'missing', raw: {} }];
    },
    async loadMcpServers() {
      return { host: 'codex', servers: [], unavailable: [] };
    },
    async loadSurfaceInventory() {
      return { host: 'codex', localSurfaces: [], homeSurfaces: [], unavailable: [] };
    },
  };
}

describe('runWithProvider', () => {
  test('captures a successful provider run into manifest artifacts and work item linkage', async () => {
    const workStore = new WorkItemStore(dir);
    const item = await workStore.create({
      title: 'run with happy path',
      source_request: 'run provider',
      goal: 'provider run is captured',
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 'manifest and artifacts exist',
          verdict: 'unverified',
          evidence: [],
        },
      ],
    });
    await writeFile(join(dir, '.ditto', 'work-items', item.id, 'context-packet.md'), 'prompt\n');
    await commitAll('work item');

    let seenArgs: string[] = [];
    const mock: HostAdapter = {
      id: 'codex',
      ...baseAdapter(),
      async spawnRun(input) {
        seenArgs = input.args;
        await writeFile(join(input.repoRoot, 'README.md'), 'after\n', 'utf8');
        git(['add', 'README.md']);
        return {
          entrypoint: 'codex mock',
          stdout: new Blob(['stdout text\n']).stream(),
          stderr: new Blob(['stderr text\n']).stream(),
          completion: Promise.resolve({
            exit_code: 0,
            model_reported: 'codex-test-model',
          }),
        };
      },
    };
    unregisterHostAdapter('codex');
    registerHostAdapter(mock);

    const result = await runWithProvider(dir, {
      work_item_id: item.id,
      provider: 'codex',
      profile: 'workspace-write',
      prompt_path: `.ditto/work-items/${item.id}/context-packet.md`,
      args: ['exec', '--help'],
    });

    expect(result.exit_code).toBe(0);
    expect(seenArgs).toEqual(['exec', '--help']);

    const runStore = new RunStore(dir);
    const manifest = await runStore.get(result.run_id);
    expect(manifest.provider).toBe('codex');
    expect(manifest.entrypoint).toBe('codex mock');
    expect(manifest.model_reported).toBe('codex-test-model');
    expect(manifest.prompt_path).toBe(`.ditto/work-items/${item.id}/context-packet.md`);
    expect(manifest.exit_code).toBe(0);
    expect(manifest.git_after).toBeDefined();
    expect(manifest.changed_files).toContain('README.md');
    expect(manifest.stdout_path).toBe(`.ditto/runs/${result.run_id}/stdout.log`);
    expect(manifest.stderr_path).toBe(`.ditto/runs/${result.run_id}/stderr.log`);
    expect(manifest.diff_path).toBe(`.ditto/runs/${result.run_id}/diff.patch`);

    await expect(Bun.file(join(dir, manifest.stdout_path ?? '')).text()).resolves.toBe(
      'stdout text\n',
    );
    await expect(Bun.file(join(dir, manifest.stderr_path ?? '')).text()).resolves.toBe(
      'stderr text\n',
    );
    const diffText = await Bun.file(join(dir, manifest.diff_path ?? '')).text();
    expect(diffText).toContain('after');
    expect(diffText).toContain('README.md');

    const updatedItem = await workStore.get(item.id);
    expect(updatedItem.runs).toContain(result.run_id);
  });
});
