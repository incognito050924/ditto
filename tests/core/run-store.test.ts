import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '~/core/run-store';
import { runManifest } from '~/schemas/run-manifest';

let workDir: string;
let store: RunStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-rs-'));
  store = new RunStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function sampleInput() {
  return {
    work_item_id: 'wi_sample001',
    provider: 'claude-code' as const,
    entrypoint: 'claude code',
    profile: 'workspace-write' as const,
    cwd: '.',
    model_reported: 'claude-opus-4-7',
    git_before: {
      head: 'a'.repeat(40),
      branch: 'main',
      dirty: false,
      untracked_count: 0,
    },
  };
}

describe('RunStore', () => {
  test('create writes a schema-conformant manifest', async () => {
    const created = await store.create(sampleInput());
    expect(created.id).toMatch(/^run_[a-z0-9]{8,}$/);
    expect(created.work_item_id).toBe('wi_sample001');
    expect(created.exit_code).toBeNull();
    const re = await store.get(created.id);
    expect(re).toEqual(created);
  });

  test('two create calls produce distinct ids', async () => {
    const a = await store.create(sampleInput());
    const b = await store.create(sampleInput());
    expect(a.id).not.toBe(b.id);
  });

  test('update applies mutator and persists', async () => {
    const created = await store.create(sampleInput());
    const updated = await store.update(created.id, (cur) => ({
      ...cur,
      exit_code: 0,
      ended_at: '2026-05-24T16:00:00+09:00',
    }));
    expect(updated.exit_code).toBe(0);
    const re = await store.get(created.id);
    expect(re.exit_code).toBe(0);
  });

  test('update rejects id change', async () => {
    const created = await store.create(sampleInput());
    let thrown: unknown;
    try {
      await store.update(created.id, (cur) => ({ ...cur, id: 'run_other0001' }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test('pathFor returns paths under the run directory', () => {
    const p = store.pathFor('run_demo000001', 'stdout.log');
    expect(p.endsWith('.ditto/runs/run_demo000001/stdout.log')).toBe(true);
  });

  test('written manifest conforms to schema (round-trip)', async () => {
    const created = await store.create(sampleInput());
    const path = join(workDir, '.ditto', 'runs', created.id, 'manifest.json');
    const text = await Bun.file(path).text();
    expect(() => runManifest.parse(JSON.parse(text))).not.toThrow();
  });
});
