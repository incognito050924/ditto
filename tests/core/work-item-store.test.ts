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

function initGitRepo(dir: string) {
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  Bun.spawnSync(['git', 'config', 'user.email', 't@t'], { cwd: dir, stdout: 'pipe' });
  Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: dir, stdout: 'pipe' });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir, stdout: 'pipe' })
    .stdout.toString()
    .trim();
}

describe('WorkItemStore started_at_sha hook', () => {
  test('create leaves started_at_sha undefined (draft has no start time)', async () => {
    const created = await store.create(sampleInput());
    expect(created.started_at_sha).toBeUndefined();
  });

  test('update draft → in_progress in a git repo backfills started_at_sha', async () => {
    const headSha = initGitRepo(workDir);
    const created = await store.create(sampleInput());
    const updated = await store.update(created.id, (cur) => ({
      ...cur,
      status: 'in_progress' as const,
    }));
    expect(updated.started_at_sha).toBe(headSha);
  });

  test('update does not overwrite an existing started_at_sha', async () => {
    initGitRepo(workDir);
    const created = await store.create(sampleInput());
    const fakeSha = 'a'.repeat(40);
    await store.update(created.id, (cur) => ({
      ...cur,
      status: 'in_progress' as const,
      started_at_sha: fakeSha,
    }));
    const final = await store.update(created.id, (cur) => ({ ...cur, title: 'renamed' }));
    expect(final.started_at_sha).toBe(fakeSha);
  });

  test('update outside git repo leaves started_at_sha omitted', async () => {
    const created = await store.create(sampleInput());
    const updated = await store.update(created.id, (cur) => ({
      ...cur,
      status: 'in_progress' as const,
    }));
    expect(updated.started_at_sha).toBeUndefined();
  });

  test('legacy in_progress without started_at_sha gets backfilled on next update', async () => {
    const headSha = initGitRepo(workDir);
    const created = await store.create(sampleInput());
    // 사용자가 work-item.json을 직접 편집해 in_progress가 된 상태를 시뮬레이트:
    // 첫 update가 draft→in_progress인 데도 started_at_sha를 hook이 박지 못한 상황으로
    // 가정. 여기서는 hook이 박은 sha를 먼저 비워 동일 상태를 재현.
    await store.update(created.id, (cur) => ({ ...cur, status: 'in_progress' as const }));
    await store.update(created.id, (cur) => ({ ...cur, started_at_sha: undefined }));
    // 다음 임의의 update에서 hook이 backfill해야 한다.
    const next = await store.update(created.id, (cur) => ({ ...cur, title: 'renamed' }));
    expect(next.started_at_sha).toBe(headSha);
  });

  test('update transitioning to done does not backfill started_at_sha', async () => {
    initGitRepo(workDir);
    const created = await store.create(sampleInput());
    // ac-1을 pass로 만들고 in_progress를 거치지 않고 곧장 done으로 간다.
    // hook 조건은 `next.status === 'in_progress'`이므로 done 가는 update는
    // backfill 대상이 아님 — 마감 자산에 잘못된 현재 sha가 박히는 것을 막는다.
    await store.update(created.id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    const done = await store.update(created.id, (cur) => ({
      ...cur,
      status: 'done' as const,
      closed_at: new Date().toISOString(),
    }));
    expect(done.status).toBe('done');
    expect(done.started_at_sha).toBeUndefined();
  });
});
