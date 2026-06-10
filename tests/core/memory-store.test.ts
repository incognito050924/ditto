import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSources, sourceIdForPath } from '~/core/memory-scan';
import { MemoryEventExistsError, MemoryEventStore, MemorySourceStore } from '~/core/memory-store';
import { memoryEvent } from '~/schemas/memory-event';
import { memorySource } from '~/schemas/memory-source';

let workDir: string;

function initGitRepo(dir: string): string {
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  Bun.spawnSync(['git', 'config', 'user.email', 't@t'], { cwd: dir, stdout: 'pipe' });
  Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: dir, stdout: 'pipe' });
  Bun.spawnSync(['git', 'add', '-A'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir, stdout: 'pipe' })
    .stdout.toString()
    .trim();
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-mem-'));
  await mkdir(join(workDir, '.ditto'), { recursive: true });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function sampleEvent(id: string, over: Record<string, unknown> = {}) {
  return {
    schema_version: '0.1.0' as const,
    event_id: id,
    event_type: 'observation' as const,
    actor: { kind: 'agent' as const, role: 'reviewer' },
    text: 'something observed',
    created_at: '2026-06-09T10:00:00+00:00',
    status: 'pending' as const,
    sources: [],
    confidence_kind: 'EXTRACTED' as const,
    sensitivity: 'internal' as const,
    ...over,
  };
}

describe('MemorySourceStore', () => {
  test('write/get round-trips a schema-conformant source under dittoDir (git-tracked SoT)', async () => {
    const store = new MemorySourceStore(workDir);
    const src = memorySource.parse({
      schema_version: '0.1.0',
      source_id: 'src_abcd1234',
      source_type: 'code',
      path: 'src/a.ts',
      content_hash: 'a'.repeat(64),
      captured_at: '2026-06-09T10:00:00+00:00',
      revision: 'r1',
    });
    await store.write(src);
    // SoT lives under .ditto/memory/ (tracked), NOT .ditto/local/.
    const onDisk = join(workDir, '.ditto', 'memory', 'sources', 'src_abcd1234.json');
    expect(await Bun.file(onDisk).exists()).toBe(true);
    expect(await store.get('src_abcd1234')).toEqual(src);
  });

  test('list returns empty when nothing scanned', async () => {
    expect(await new MemorySourceStore(workDir).list()).toEqual([]);
  });
});

describe('MemoryEventStore immutability', () => {
  test('append writes an immutable per-entity file under dittoDir', async () => {
    const store = new MemoryEventStore(workDir);
    const e = await store.append(memoryEvent.parse(sampleEvent('memevt_aaaa1111')));
    const onDisk = join(workDir, '.ditto', 'memory', 'events', 'memevt_aaaa1111.json');
    expect(await Bun.file(onDisk).exists()).toBe(true);
    expect(e.event_id).toBe('memevt_aaaa1111');
  });

  test('append to an existing event id fails (immutable, append-only)', async () => {
    const store = new MemoryEventStore(workDir);
    await store.append(memoryEvent.parse(sampleEvent('memevt_dup00001')));
    let thrown: unknown;
    try {
      await store.append(memoryEvent.parse(sampleEvent('memevt_dup00001', { text: 'mutated' })));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MemoryEventExistsError);
    // Original file is unchanged (no mutation).
    expect((await store.get('memevt_dup00001')).text).toBe('something observed');
  });

  test('approval is a NEW superseding event; original pending file is preserved', async () => {
    const store = new MemoryEventStore(workDir);
    await store.append(memoryEvent.parse(sampleEvent('memevt_pend0001')));
    await store.append(
      memoryEvent.parse(
        sampleEvent('memevt_appr0001', {
          status: 'approved',
          approved_by: 'user',
          decided_at: '2026-06-09T11:00:00+00:00',
          supersedes: 'memevt_pend0001',
          created_at: '2026-06-09T11:00:00+00:00',
        }),
      ),
    );
    const all = await store.list();
    expect(all.map((e) => e.event_id)).toEqual(['memevt_pend0001', 'memevt_appr0001']);
    expect((await store.get('memevt_pend0001')).status).toBe('pending');
    expect((await store.get('memevt_appr0001')).supersedes).toBe('memevt_pend0001');
  });

  test('approval invariant enforced by schema (approved without approved_by rejected)', () => {
    expect(() =>
      memoryEvent.parse(sampleEvent('memevt_bad00001', { status: 'approved' })),
    ).toThrow();
  });

  test('list sorts by created_at ascending', async () => {
    const store = new MemoryEventStore(workDir);
    await store.append(
      memoryEvent.parse(
        sampleEvent('memevt_late0001', { created_at: '2026-06-09T12:00:00+00:00' }),
      ),
    );
    await store.append(
      memoryEvent.parse(
        sampleEvent('memevt_early001', { created_at: '2026-06-09T08:00:00+00:00' }),
      ),
    );
    const ids = (await store.list()).map((e) => e.event_id);
    expect(ids).toEqual(['memevt_early001', 'memevt_late0001']);
  });
});

describe('scanSources change detection', () => {
  test('first scan reports all files as added; rescan with no change reports unchanged', async () => {
    initGitRepo(workDir);
    await writeFile(join(workDir, 'a.ts'), 'export const x = 1;\n');
    await writeFile(join(workDir, 'README.md'), '# hi\n');

    const first = await scanSources(workDir);
    expect(first.added.length).toBe(2);
    expect(first.changed.length).toBe(0);
    expect(first.unchanged.length).toBe(0);

    const second = await scanSources(workDir);
    expect(second.added.length).toBe(0);
    expect(second.changed.length).toBe(0);
    expect(second.unchanged.length).toBe(2);
  });

  test('editing a file is detected as changed on rescan', async () => {
    initGitRepo(workDir);
    const file = join(workDir, 'a.ts');
    await writeFile(file, 'export const x = 1;\n');
    await scanSources(workDir);
    await writeFile(file, 'export const x = 2;\n');
    const r = await scanSources(workDir);
    expect(r.changed).toEqual([sourceIdForPath('a.ts')]);
    expect(r.added.length).toBe(0);
  });

  // R7 (round-2 review): the secret gate rides on the source record's
  // sensitivity; a rescan must not silently reset a manual 'secret' marking.
  test('R7: rescan preserves a manually-set sensitivity when content changes', async () => {
    initGitRepo(workDir);
    const file = join(workDir, 'leaky.ts');
    await writeFile(file, 'export const t = "v1";\n');
    await scanSources(workDir);
    const store = new MemorySourceStore(workDir);
    const id = sourceIdForPath('leaky.ts');
    const src = await store.get(id);
    await store.write({ ...src, sensitivity: 'secret' });
    await writeFile(file, 'export const t = "v2";\n');
    const r = await scanSources(workDir);
    expect(r.changed).toEqual([id]);
    expect((await store.get(id)).sensitivity).toBe('secret');
  });

  test('source id is stable and path-derived across scans', async () => {
    initGitRepo(workDir);
    await writeFile(join(workDir, 'a.ts'), 'export const x = 1;\n');
    const r = await scanSources(workDir);
    expect(r.scanned[0]?.source.source_id).toBe(sourceIdForPath('a.ts'));
  });

  test('single-repo scan records repoRoot HEAD as revision and omits repo (cost 0)', async () => {
    const head = initGitRepo(workDir);
    await writeFile(join(workDir, 'a.ts'), 'export const x = 1;\n');
    await scanSources(workDir);
    const src = await new MemorySourceStore(workDir).get(sourceIdForPath('a.ts'));
    expect(src.revision).toBe(head);
    expect(src.git_commit).toBe(head);
    expect(src.repo).toBeUndefined();
  });

  test('multi-repo: a source under a sub-repo is attributed to that repo with its HEAD', async () => {
    // workspace = rooting root (has .ditto); sub/ is a distinct git repo.
    initGitRepo(workDir);
    const sub = join(workDir, 'sub');
    await mkdir(sub, { recursive: true });
    const subHead = initGitRepo(sub);
    await writeFile(join(sub, 'b.ts'), 'export const y = 1;\n');

    await scanSources(workDir);
    const src = await new MemorySourceStore(workDir).get(sourceIdForPath(join('sub', 'b.ts')));
    expect(src.repo).toBe('sub');
    expect(src.revision).toBe(subHead);
    expect(src.git_commit).toBe(subHead);
  });

  test('written source files conform to the memorySource schema', async () => {
    initGitRepo(workDir);
    await writeFile(join(workDir, 'a.ts'), 'export const x = 1;\n');
    await scanSources(workDir);
    const all = await new MemorySourceStore(workDir).list();
    expect(all.length).toBe(1);
    expect(() => memorySource.parse(all[0])).not.toThrow();
  });
});
