import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkItemStore } from '~/core/work-item-store';
import { workItem } from '~/schemas/work-item';

let workDir: string;
let store: WorkItemStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-wis-'));
  store = new WorkItemStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function sampleInput() {
  return {
    title: 'sample',
    source_request: '사용자 요청 원문',
    goal: '관측 가능한 목표 한 문장',
    acceptance_criteria: [
      {
        id: 'ac-1',
        statement: '명시적 관찰 가능한 조건',
        verdict: 'unverified' as const,
        evidence: [],
      },
    ],
  };
}

describe('WorkItemStore', () => {
  test('create writes a schema-conformant work-item.json', async () => {
    const created = await store.create(sampleInput());
    expect(created.id).toMatch(/^wi_[a-z0-9]{8,}$/);
    expect(created.status).toBe('draft');
    expect(created.acceptance_criteria).toHaveLength(1);
    // Re-read via readJson path; will throw if file is missing or invalid
    const re = await store.get(created.id);
    expect(re).toEqual(created);
  });

  test('create also writes language-ledger.json', async () => {
    const created = await store.create(sampleInput());
    const ledgerPath = join(workDir, '.ditto', 'work-items', created.id, 'language-ledger.json');
    const text = await Bun.file(ledgerPath).text();
    const parsed = JSON.parse(text);
    expect(parsed.work_item_id).toBe(created.id);
    expect(parsed.changes).toEqual([]);
  });

  test('two create calls produce distinct ids', async () => {
    const a = await store.create(sampleInput());
    const b = await store.create(sampleInput());
    expect(a.id).not.toBe(b.id);
  });

  test('update applies mutator and bumps updated_at', async () => {
    const created = await store.create(sampleInput());
    const before = created.updated_at;
    // Force a tick so updated_at strictly increases
    await new Promise((r) => setTimeout(r, 5));
    const updated = await store.update(created.id, (cur) => ({
      ...cur,
      title: 'renamed',
    }));
    expect(updated.title).toBe('renamed');
    expect(updated.updated_at >= before).toBe(true);
  });

  test('update rejects changing the id', async () => {
    const created = await store.create(sampleInput());
    let thrown: unknown;
    try {
      await store.update(created.id, (cur) => ({ ...cur, id: 'wi_different01' }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test('update rejects mutations that break schema', async () => {
    const created = await store.create(sampleInput());
    let thrown: unknown;
    try {
      await store.update(created.id, (cur) => ({
        ...cur,
        // Setting status=blocked requires re_entry; mutator omits it
        status: 'blocked',
      }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test('list returns summaries sorted by updated_at desc', async () => {
    const a = await store.create({ ...sampleInput(), title: 'a' });
    await new Promise((r) => setTimeout(r, 10));
    const b = await store.create({ ...sampleInput(), title: 'b' });
    const summaries = await store.list();
    expect(summaries.map((s) => s.id)).toEqual([b.id, a.id]);
  });

  test('list returns empty array when no work items exist', async () => {
    const summaries = await store.list();
    expect(summaries).toEqual([]);
  });

  test('appendCommandLogLine creates evidence directory and appends', async () => {
    const created = await store.create(sampleInput());
    const line1 = JSON.stringify({
      ts: '2026-05-24T15:00:00+09:00',
      kind: 'command',
      command: 'echo hi',
      exit_code: 0,
    });
    const line2 = JSON.stringify({
      ts: '2026-05-24T15:01:00+09:00',
      kind: 'command',
      command: 'echo bye',
      exit_code: 0,
    });
    await store.appendCommandLogLine(created.id, line1);
    await store.appendCommandLogLine(created.id, line2);
    const path = join(workDir, '.ditto', 'work-items', created.id, 'evidence', 'commands.jsonl');
    const text = await Bun.file(path).text();
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ command: 'echo hi' });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ command: 'echo bye' });
  });

  test('written file conforms to workItem schema (round-trip)', async () => {
    const created = await store.create(sampleInput());
    const path = join(workDir, '.ditto', 'work-items', created.id, 'work-item.json');
    const text = await Bun.file(path).text();
    const parsed = JSON.parse(text);
    expect(() => workItem.parse(parsed)).not.toThrow();
  });
});
