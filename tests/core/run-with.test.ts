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
import { RunWithRuntimeError, runWithProvider } from '~/core/run-with';
import { WorkItemStore } from '~/core/work-item-store';
import { runManifest } from '~/schemas/run-manifest';

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

async function createWorkItem(title: string) {
  const workStore = new WorkItemStore(dir);
  const item = await workStore.create({
    title,
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
  await commitAll(`work item ${title}`);
  return item;
}

function registerMock(spawnRun: NonNullable<HostAdapter['spawnRun']>): void {
  unregisterHostAdapter('codex');
  registerHostAdapter({
    id: 'codex',
    ...baseAdapter(),
    spawnRun,
  });
}

async function runFixture(workItemId: string) {
  return runWithProvider(dir, {
    work_item_id: workItemId,
    provider: 'codex',
    profile: 'workspace-write',
    args: ['exec', '--help'],
  });
}

function failingStream(message: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.error(new Error(message));
    },
  });
}

const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY'];

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

  test('automatic run manifest validates against runManifest schema after round trip', async () => {
    const item = await createWorkItem('round trip');
    registerMock(async () => ({
      entrypoint: 'codex mock',
      stdout: new Blob(['ok\n']).stream(),
      stderr: new Blob(['']).stream(),
      completion: Promise.resolve({ exit_code: 0, model_reported: null }),
    }));

    const result = await runFixture(item.id);
    const raw = JSON.parse(
      await Bun.file(join(dir, '.ditto', 'runs', result.run_id, 'manifest.json')).text(),
    );
    expect(() => runManifest.parse(raw)).not.toThrow();
  });

  test('captures provider non-zero exit as a completed provider failure', async () => {
    const item = await createWorkItem('non zero');
    registerMock(async () => ({
      entrypoint: 'codex mock',
      stdout: new Blob(['stdout before failure\n']).stream(),
      stderr: new Blob(['provider failed\n']).stream(),
      completion: Promise.resolve({ exit_code: 42, model_reported: 'codex-test-model' }),
    }));

    const result = await runFixture(item.id);
    const manifest = await new RunStore(dir).get(result.run_id);
    expect(result.exit_code).toBe(42);
    expect(manifest.exit_code).toBe(42);
    expect(manifest.model_reported).toBe('codex-test-model');
    expect(manifest.ended_at).toBeDefined();
    expect(manifest.unverified).toEqual([]);
    await expect(Bun.file(join(dir, manifest.stderr_path ?? '')).text()).resolves.toBe(
      'provider failed\n',
    );
  });

  test('captures completion rejection as null exit and HostAdapter contract bug evidence', async () => {
    const item = await createWorkItem('completion reject');
    registerMock(async () => ({
      entrypoint: 'codex mock',
      stdout: new Blob(['partial stdout\n']).stream(),
      stderr: new Blob(['partial stderr\n']).stream(),
      completion: new Promise((_, reject) => {
        setTimeout(() => reject(new Error('completion exploded')), 20);
      }),
    }));

    const result = await runFixture(item.id);
    const manifest = await new RunStore(dir).get(result.run_id);
    expect(result.exit_code).toBeNull();
    expect(manifest.exit_code).toBeNull();
    expect(manifest.notes).toContain('adapter completion rejected: completion exploded');
    expect(manifest.unverified).toContain(
      'adapter completion promise rejected; this is a HostAdapter contract bug',
    );
  });

  test('captures spawn throw as best-effort manifest and runtime error result', async () => {
    const item = await createWorkItem('spawn throw');
    registerMock(async () => {
      throw new Error('spawn unavailable');
    });

    let caught: unknown;
    try {
      await runFixture(item.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RunWithRuntimeError);
    const result = (caught as RunWithRuntimeError).result;
    expect(result?.exit_code).toBeNull();
    const manifest = await new RunStore(dir).get(result?.run_id ?? '');
    expect(manifest.exit_code).toBeNull();
    expect(manifest.notes).toContain('adapter spawnRun threw: spawn unavailable');
    expect(manifest.unverified).toContain('adapter spawnRun threw: spawn unavailable');
    expect(manifest.git_after).toBeDefined();
  });

  test('captures signal kill as null exit with signal notes', async () => {
    const item = await createWorkItem('signal kill');
    registerMock(async () => ({
      entrypoint: 'codex mock',
      stdout: new Blob(['stdout before signal\n']).stream(),
      stderr: new Blob(['stderr before signal\n']).stream(),
      completion: Promise.resolve({
        exit_code: null,
        model_reported: null,
        signal: 'SIGTERM',
      }),
    }));

    const result = await runFixture(item.id);
    const manifest = await new RunStore(dir).get(result.run_id);
    expect(result.exit_code).toBeNull();
    expect(manifest.exit_code).toBeNull();
    expect(manifest.notes).toContain('signal: SIGTERM');
    expect(manifest.stdout_path).toBe(`.ditto/runs/${result.run_id}/stdout.log`);
  });

  test('captures mid-pipe stream failure as unverified artifact evidence', async () => {
    const item = await createWorkItem('stream failure');
    registerMock(async () => ({
      entrypoint: 'codex mock',
      stdout: failingStream('stdout pipe failed'),
      stderr: new Blob(['stderr survived\n']).stream(),
      completion: Promise.resolve({ exit_code: 0, model_reported: null }),
    }));

    const result = await runFixture(item.id);
    const manifest = await new RunStore(dir).get(result.run_id);
    expect(result.exit_code).toBe(0);
    expect(manifest.exit_code).toBe(0);
    expect(manifest.unverified.join('\n')).toContain('artifact capture failed');
    expect(manifest.unverified.join('\n')).toContain('stdout pipe failed');
  });

  test('rejects cwd outside the repo before provider spawn', async () => {
    const item = await createWorkItem('cwd outside');
    let called = false;
    registerMock(async () => {
      called = true;
      return {
        entrypoint: 'codex mock',
        stdout: new Blob(['']).stream(),
        stderr: new Blob(['']).stream(),
        completion: Promise.resolve({ exit_code: 0, model_reported: null }),
      };
    });

    let thrown: unknown;
    try {
      await runWithProvider(dir, {
        work_item_id: item.id,
        provider: 'codex',
        profile: 'workspace-write',
        cwd: '../outside',
        args: ['exec'],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain('invalid cwd');
    expect(called).toBe(false);
  });

  test('isolated profile spawns inside a per-run worktree and records worktree_path', async () => {
    const item = await createWorkItem('isolated worktree');
    let seenRepoRoot = '';
    let seenCwd = '';
    registerMock(async (input) => {
      seenRepoRoot = input.repoRoot;
      seenCwd = input.cwd;
      await writeFile(join(input.repoRoot, 'inside.txt'), 'work\n', 'utf8');
      return {
        entrypoint: 'codex mock',
        stdout: new Blob(['']).stream(),
        stderr: new Blob(['']).stream(),
        completion: Promise.resolve({ exit_code: 0, model_reported: null }),
      };
    });

    const result = await runWithProvider(dir, {
      work_item_id: item.id,
      provider: 'codex',
      profile: 'isolated',
      args: ['exec'],
    });

    const expectedWorktree = `.ditto/worktrees/${result.run_id}`;
    expect(seenRepoRoot).toBe(join(dir, expectedWorktree));
    expect(seenCwd).toBe('.');
    const manifest = await new RunStore(dir).get(result.run_id);
    expect(manifest.worktree_path).toBe(expectedWorktree);
    expect(manifest.changed_files).toContain('inside.txt');
    const mainStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(mainStatus).not.toContain('inside.txt');
  });

  test.each([
    ['read-only', true, true],
    ['workspace-write', true, false],
    ['reviewer', true, true],
    ['networked', false, false],
    ['isolated', true, false],
  ] as const)(
    'applies profile policy for %s',
    async (profile, expectProxyUnset, expectWriteViolation) => {
      const item = await createWorkItem(`profile ${profile}`);
      let unset: string[] = [];
      registerMock(async (input) => {
        unset = input.env.unset;
        await writeFile(join(input.repoRoot, `${profile}.txt`), 'changed\n', 'utf8');
        return {
          entrypoint: 'codex mock',
          stdout: new Blob(['']).stream(),
          stderr: new Blob(['']).stream(),
          completion: Promise.resolve({ exit_code: 0, model_reported: null }),
        };
      });

      const result = await runWithProvider(dir, {
        work_item_id: item.id,
        provider: 'codex',
        profile,
        args: ['exec'],
      });

      if (expectProxyUnset) {
        for (const key of proxyKeys) expect(unset).toContain(key);
      } else {
        for (const key of proxyKeys) expect(unset).not.toContain(key);
      }
      const manifest = await new RunStore(dir).get(result.run_id);
      expect(manifest.changed_files).toContain(`${profile}.txt`);
      if (expectWriteViolation) {
        expect(manifest.unverified).toContain('profile violated: writes detected');
      } else {
        expect(manifest.unverified).not.toContain('profile violated: writes detected');
      }
    },
  );

  test('--verify command success appends a Verification entry with output_path', async () => {
    const item = await createWorkItem('verify pass');
    registerMock(async () => ({
      entrypoint: 'codex mock',
      stdout: new Blob(['']).stream(),
      stderr: new Blob(['']).stream(),
      completion: Promise.resolve({ exit_code: 0, model_reported: null }),
    }));

    const result = await runWithProvider(dir, {
      work_item_id: item.id,
      provider: 'codex',
      profile: 'workspace-write',
      args: ['exec'],
      verify_command: 'pwd',
    });

    expect(result.exit_code).toBe(0);
    const manifest = await new RunStore(dir).get(result.run_id);
    expect(manifest.verifications).toHaveLength(1);
    const entry = manifest.verifications[0];
    expect(entry.command).toBe('pwd');
    expect(entry.exit_code).toBe(0);
    expect(entry.output_path).toBe(`.ditto/runs/${result.run_id}/verify.log`);
    expect(typeof entry.duration_ms).toBe('number');
    expect(entry.notes).toBeUndefined();
    const log = await Bun.file(join(dir, entry.output_path ?? '')).text();
    expect(log.length).toBeGreaterThan(0);

    const updatedItem = await new WorkItemStore(dir).get(item.id);
    expect(updatedItem.runs).toContain(result.run_id);
  });

  test('--verify command non-zero exit is recorded without escalating to a run failure', async () => {
    const item = await createWorkItem('verify fail');
    registerMock(async () => ({
      entrypoint: 'codex mock',
      stdout: new Blob(['']).stream(),
      stderr: new Blob(['']).stream(),
      completion: Promise.resolve({ exit_code: 0, model_reported: null }),
    }));

    const result = await runWithProvider(dir, {
      work_item_id: item.id,
      provider: 'codex',
      profile: 'workspace-write',
      args: ['exec'],
      verify_command: 'false',
    });

    expect(result.exit_code).toBe(0);
    const manifest = await new RunStore(dir).get(result.run_id);
    expect(manifest.verifications).toHaveLength(1);
    expect(manifest.verifications[0].command).toBe('false');
    expect(manifest.verifications[0].exit_code).not.toBe(0);
    expect(manifest.verifications[0].notes).toBeUndefined();

    const updatedItem = await new WorkItemStore(dir).get(item.id);
    expect(updatedItem.runs).toContain(result.run_id);
  });

  test('--verify spawn failure records exit_code=-1 with notes and preserves run capture', async () => {
    const item = await createWorkItem('verify spawn fail');
    registerMock(async () => ({
      entrypoint: 'codex mock',
      stdout: new Blob(['']).stream(),
      stderr: new Blob(['']).stream(),
      completion: Promise.resolve({ exit_code: 0, model_reported: null }),
    }));

    const result = await runWithProvider(dir, {
      work_item_id: item.id,
      provider: 'codex',
      profile: 'workspace-write',
      args: ['exec'],
      verify_command: 'ditto-no-such-binary-xyz12345',
    });

    expect(result.exit_code).toBe(0);
    const manifest = await new RunStore(dir).get(result.run_id);
    expect(manifest.verifications).toHaveLength(1);
    expect(manifest.verifications[0].exit_code).toBe(-1);
    expect(manifest.verifications[0].notes ?? '').toContain('verify spawn failed');

    const updatedItem = await new WorkItemStore(dir).get(item.id);
    expect(updatedItem.runs).toContain(result.run_id);
  });

  test('no --verify keeps verifications empty (existing happy-path is unaffected)', async () => {
    const item = await createWorkItem('no verify');
    registerMock(async () => ({
      entrypoint: 'codex mock',
      stdout: new Blob(['']).stream(),
      stderr: new Blob(['']).stream(),
      completion: Promise.resolve({ exit_code: 0, model_reported: null }),
    }));

    const result = await runFixture(item.id);
    const manifest = await new RunStore(dir).get(result.run_id);
    expect(manifest.verifications).toEqual([]);
  });
});
