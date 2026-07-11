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
    const ledgerPath = join(
      workDir,
      '.ditto',
      'local',
      'work-items',
      created.id,
      'language-ledger.json',
    );
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
    const path = join(
      workDir,
      '.ditto',
      'local',
      'work-items',
      created.id,
      'evidence',
      'commands.jsonl',
    );
    const text = await Bun.file(path).text();
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ command: 'echo hi' });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ command: 'echo bye' });
  });

  test('written file conforms to workItem schema (round-trip)', async () => {
    const created = await store.create(sampleInput());
    const path = join(workDir, '.ditto', 'local', 'work-items', created.id, 'work-item.json');
    const text = await Bun.file(path).text();
    const parsed = JSON.parse(text);
    expect(() => workItem.parse(parsed)).not.toThrow();
  });

  test('appendMetricLine writes metrics.jsonl at the work-item root (not under evidence/)', async () => {
    const created = await store.create(sampleInput());
    const line = JSON.stringify({
      ts: '2026-06-08T15:00:00+09:00',
      work_item_id: created.id,
      kind: 'intent_drift',
      source: 'stop_hook',
      blocking_reasons: ['H1: scope grow'],
      advisories: [],
      hops: ['H1'],
    });
    await store.appendMetricLine(created.id, line);
    const rootPath = join(workDir, '.ditto', 'local', 'work-items', created.id, 'metrics.jsonl');
    expect(await Bun.file(rootPath).exists()).toBe(true);
  });

  test('readMetrics round-trips appended lines and validates the schema', async () => {
    const created = await store.create(sampleInput());
    const mk = (hop: string) =>
      JSON.stringify({
        ts: '2026-06-08T15:00:00+09:00',
        work_item_id: created.id,
        kind: 'intent_drift',
        source: 'stop_hook',
        blocking_reasons: [`${hop}: scope shrink`],
        advisories: [],
        hops: [hop],
      });
    await store.appendMetricLine(created.id, mk('H1'));
    await store.appendMetricLine(created.id, mk('H2'));
    const metrics = await store.readMetrics(created.id);
    expect(metrics.length).toBe(2);
    expect(metrics[0]?.hops).toEqual(['H1']);
    expect(metrics[1]?.hops).toEqual(['H2']);
  });

  test('readMetrics returns empty when no metrics file exists', async () => {
    const created = await store.create(sampleInput());
    expect(await store.readMetrics(created.id)).toEqual([]);
  });

  test('appendQuestionRoundLine writes question-rounds.jsonl at the work-item root', async () => {
    const created = await store.create(sampleInput());
    const line = JSON.stringify({
      ts: '2026-06-19T05:00:00.000Z',
      work_item_id: created.id,
      round: 1,
      dry: true,
      selected: [],
      all_scored: [],
      generator_count: 3,
    });
    await store.appendQuestionRoundLine(created.id, line);
    const rootPath = join(
      workDir,
      '.ditto',
      'local',
      'work-items',
      created.id,
      'question-rounds.jsonl',
    );
    expect(await Bun.file(rootPath).exists()).toBe(true);
  });

  test('readQuestionRounds round-trips appended lines and validates the schema', async () => {
    const created = await store.create(sampleInput());
    const mk = (round: number, dry: boolean) =>
      JSON.stringify({
        ts: '2026-06-19T05:00:00.000Z',
        work_item_id: created.id,
        round,
        dry,
        selected: dry
          ? []
          : [
              {
                text: 'q',
                property: 'blind-spot',
                scores: { consensus: 2, quality: 0.8, necessity: 0.7, answer_value: 0.9 },
              },
            ],
        all_scored: [],
        generator_count: 3,
      });
    await store.appendQuestionRoundLine(created.id, mk(1, false));
    await store.appendQuestionRoundLine(created.id, mk(2, true));
    const rounds = await store.readQuestionRounds(created.id);
    expect(rounds.length).toBe(2);
    expect(rounds[0]?.round).toBe(1);
    expect(rounds[0]?.selected[0]?.scores.answer_value).toBe(0.9);
    expect(rounds[1]?.dry).toBe(true);
  });

  test('readQuestionRounds returns empty when no rounds file exists', async () => {
    const created = await store.create(sampleInput());
    expect(await store.readQuestionRounds(created.id)).toEqual([]);
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

// wi_260710s4j (n2 frozen-red): at the draft→in_progress edge the store captures a
// one-shot UNTRACKED baseline (`started_untracked_baseline`) onto the committed Record
// (record.json), so autopilot's later `changed_files` accounting can exclude foreign
// untracked dirt that predated the run. Distinct predicate from started_at_sha: it is
// EDGE-only (no lazy legacy backfill), untracked-only, and omitted when git yields
// nothing (fail-open). These drive the not-yet-existing field + capture hook.
describe('WorkItemStore started_untracked_baseline capture (wi_260710s4j)', () => {
  test('draft → in_progress captures the untracked baseline once, persisted to record.json', async () => {
    initGitRepo(workDir);
    const created = await store.create(sampleInput());
    // A FOREIGN untracked file already lying in the tree at run start.
    await Bun.write(join(workDir, 'foreign.txt'), 'pre-existing dirt');
    const updated = await store.update(created.id, (cur) => ({
      ...cur,
      status: 'in_progress' as const,
    }));
    // The baseline exists and captured the foreign untracked path.
    const baseline = (updated as { started_untracked_baseline?: string[] })
      .started_untracked_baseline;
    expect(baseline).toBeDefined();
    expect(baseline).toContain('foreign.txt');
    // Persisted onto the committed Record (record.json), not only the in-memory view.
    const recordPath = join(workDir, '.ditto', 'work-items', created.id, 'record.json');
    const persisted = JSON.parse(await Bun.file(recordPath).text());
    expect(persisted.started_untracked_baseline).toContain('foreign.txt');
  });

  test('the baseline is untracked-only — a tracked-but-modified file is excluded', async () => {
    initGitRepo(workDir);
    // A committed (tracked) file, later modified → dirty but NOT untracked.
    await Bun.write(join(workDir, 'tracked.txt'), 'v1');
    Bun.spawnSync(['git', 'add', 'tracked.txt'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'add tracked'], { cwd: workDir, stdout: 'pipe' });
    await Bun.write(join(workDir, 'tracked.txt'), 'v2'); // tracked-dirty
    await Bun.write(join(workDir, 'foreign.txt'), 'untracked dirt'); // untracked
    const created = await store.create(sampleInput());
    const updated = await store.update(created.id, (cur) => ({
      ...cur,
      status: 'in_progress' as const,
    }));
    const baseline =
      (updated as { started_untracked_baseline?: string[] }).started_untracked_baseline ?? [];
    expect(baseline).toContain('foreign.txt');
    expect(baseline).not.toContain('tracked.txt');
  });

  test('captured only at the draft → in_progress edge — a later update does not re-capture', async () => {
    initGitRepo(workDir);
    const created = await store.create(sampleInput());
    await Bun.write(join(workDir, 'foreign-at-start.txt'), 'dirt present at run start');
    const started = await store.update(created.id, (cur) => ({
      ...cur,
      status: 'in_progress' as const,
    }));
    const baselineAtStart =
      (started as { started_untracked_baseline?: string[] }).started_untracked_baseline ?? [];
    expect(baselineAtStart).toContain('foreign-at-start.txt');
    // A NEW untracked file appears AFTER the run started, then an unrelated in_progress
    // → in_progress update fires. Unlike started_at_sha's legacy backfill, the baseline
    // is edge-only: it must NOT re-capture the newly-appeared path.
    await Bun.write(join(workDir, 'appeared-after.txt'), 'post-start dirt');
    const later = await store.update(created.id, (cur) => ({ ...cur, title: 'renamed' }));
    const baselineLater =
      (later as { started_untracked_baseline?: string[] }).started_untracked_baseline ?? [];
    expect(baselineLater).toContain('foreign-at-start.txt');
    expect(baselineLater).not.toContain('appeared-after.txt');
  });

  test('outside a git repo the baseline is omitted (fail-open, not an empty array)', async () => {
    // Boundary guard: no git → capture degrades to omission, never a throw or a stored
    // empty array (absent baseline = fail-open "exclude nothing" downstream).
    const created = await store.create(sampleInput());
    const updated = await store.update(created.id, (cur) => ({
      ...cur,
      status: 'in_progress' as const,
    }));
    expect(
      (updated as { started_untracked_baseline?: string[] }).started_untracked_baseline,
    ).toBeUndefined();
  });
});

describe('WorkItemStore.close', () => {
  test('abandon sets status=abandoned + closed_at', async () => {
    const created = await store.create(sampleInput());
    const closed = await store.close(created.id, 'abandoned');
    expect(closed.status).toBe('abandoned');
    expect(closed.closed_at).toBeDefined();
    // persisted
    expect((await store.get(created.id)).status).toBe('abandoned');
  });

  test('close to done sets status=done + closed_at', async () => {
    const created = await store.create(sampleInput());
    const closed = await store.close(created.id, 'done');
    expect(closed.status).toBe('done');
    expect(closed.closed_at).toBeDefined();
  });

  // R1 terminal guard: close() is the chokepoint protecting every terminal
  // transition (manual done/abandon + the autopilot pass->done flip). An
  // already-terminal WI must not be silently overwritten -- re-closing throws
  // with no disk write, so abandoned can never be quietly flipped to done.
  test('re-closing an already-done WI throws (already terminal)', async () => {
    const created = await store.create(sampleInput());
    await store.close(created.id, 'done');
    expect(store.close(created.id, 'done')).rejects.toThrow(/terminal/);
  });

  test('closing an abandoned WI to done throws (no silent overwrite)', async () => {
    const created = await store.create(sampleInput());
    await store.close(created.id, 'abandoned');
    expect(store.close(created.id, 'done')).rejects.toThrow(/terminal/);
    // status unchanged on disk
    expect((await store.get(created.id)).status).toBe('abandoned');
  });
});

describe('WorkItemStore.reopen', () => {
  test('done -> in_progress and clears closed_at', async () => {
    const created = await store.create(sampleInput());
    const done = await store.close(created.id, 'done');
    expect(done.closed_at).toBeDefined();
    const reopened = await store.reopen(created.id);
    expect(reopened.status).toBe('in_progress');
    expect(reopened.closed_at).toBeUndefined();
    expect((await store.get(created.id)).status).toBe('in_progress');
  });

  test('abandoned -> in_progress (then closeable to done)', async () => {
    const created = await store.create(sampleInput());
    await store.close(created.id, 'abandoned');
    await store.reopen(created.id);
    const reclosed = await store.close(created.id, 'done');
    expect(reclosed.status).toBe('done');
  });

  test('reopen on a non-terminal WI throws', async () => {
    const created = await store.create(sampleInput());
    expect(store.reopen(created.id)).rejects.toThrow(/not terminal/);
  });
});

describe('WorkItemStore.archive', () => {
  test('moves done/abandoned items to .ditto/local/archive/<label>, leaves non-terminal', async () => {
    const a = await store.create({ ...sampleInput(), title: 'done-one' });
    const b = await store.create({ ...sampleInput(), title: 'abandoned-one' });
    const c = await store.create({ ...sampleInput(), title: 'still-draft' });
    await store.close(a.id, 'done');
    await store.close(b.id, 'abandoned');

    const moved = await store.archive('2026-Q2');
    expect(moved.sort()).toEqual([a.id, b.id].sort());

    // archived items leave the active list; the draft stays
    const remaining = (await store.list()).map((s) => s.id);
    expect(remaining).toEqual([c.id]);

    // move-not-delete: files exist under archive/<label>/<wi>
    const archivedPath = join(
      workDir,
      '.ditto',
      'local',
      'archive',
      '2026-Q2',
      a.id,
      'work-item.json',
    );
    expect(await Bun.file(archivedPath).exists()).toBe(true);
  });

  test('rejects a label with path traversal', async () => {
    await expect(store.archive('../escape')).rejects.toThrow();
  });

  test('rejects bare dot-segment labels (. and ..)', async () => {
    // '.'/'..' pass the [A-Za-z0-9._-]+ charset but resolve to the wrong dir
    // (one level up from archive/), so they must be rejected explicitly.
    await expect(store.archive('..')).rejects.toThrow();
    await expect(store.archive('.')).rejects.toThrow();
  });

  test('returns empty when nothing is terminal', async () => {
    await store.create(sampleInput());
    expect(await store.archive('empty')).toEqual([]);
  });
});
