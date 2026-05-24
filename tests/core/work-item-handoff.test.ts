import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvalidBaseRefError,
  InvalidHeadRefError,
  writeWorkItemHandoff,
} from '~/core/work-item-handoff';
import { WorkItemStore } from '~/core/work-item-store';

let workDir: string;
let store: WorkItemStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-hand-'));
  store = new WorkItemStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function makeInput() {
  return {
    title: 'sample',
    source_request: 'req',
    goal: 'goal',
    acceptance_criteria: [
      { id: 'ac-1', statement: 's', verdict: 'unverified' as const, evidence: [] },
    ],
  };
}

describe('writeWorkItemHandoff', () => {
  test('pass path: status=done, no re_entry, no resume in handoff.md', async () => {
    const created = await store.create(makeInput());
    // mark ac-1 as pass
    await store.update(created.id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    expect(result.completion.final_verdict).toBe('pass');
    const updated = await store.get(created.id);
    expect(updated.status).toBe('done');
    expect(updated.re_entry).toBeUndefined();
    expect(updated.closed_at).toBeDefined();
    const handoffText = await Bun.file(result.handoffPath).text();
    expect(handoffText).not.toContain('다음 명령');
    expect(handoffText).not.toContain('다음 fresh evidence');
    expect(handoffText).not.toContain('ditto work resume');
  });

  test('partial path: status=partial, re_entry set, resume in handoff.md', async () => {
    const created = await store.create(makeInput());
    // ac-1 stays unverified → final_verdict=partial
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    expect(result.completion.final_verdict).toBe('partial');
    const updated = await store.get(created.id);
    expect(updated.status).toBe('partial');
    expect(updated.re_entry).toBeDefined();
    const handoffText = await Bun.file(result.handoffPath).text();
    expect(handoffText).toContain('## 다음 명령');
    expect(handoffText).toContain('ditto work resume');
  });

  test('changed_files: when work item has runs/evidence but no diff base, unverified entry is added in-scope', async () => {
    const created = await store.create(makeInput());
    // mark ac-1 pass and add an evidence entry so the item has "evidence"
    await store.update(created.id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1'
          ? {
              ...c,
              verdict: 'pass' as const,
              evidence: [{ kind: 'command' as const, command: 'echo' }],
            }
          : c,
      ),
    }));
    // workDir is not a git repo → no base, no changed_files collectable
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    // unverified should include changed_files entry; final_verdict can't be pass
    const inScopeUnverified = result.completion.unverified.filter((u) => !u.out_of_scope);
    const hasChangedFilesEntry = inScopeUnverified.some(
      (u) => u.item === 'changed_files not recorded',
    );
    expect(hasChangedFilesEntry).toBe(true);
    expect(result.completion.final_verdict).not.toBe('pass');
  });

  test('explicit --base that does not resolve throws InvalidBaseRefError', async () => {
    const created = await store.create(makeInput());
    let thrown: unknown;
    try {
      await writeWorkItemHandoff(workDir, store, created.id, {
        base: '__definitely_missing_ref__',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidBaseRefError);
    // completion.json must not have been written
    const completionPath = join(workDir, '.ditto', 'work-items', created.id, 'completion.json');
    expect(await Bun.file(completionPath).exists()).toBe(false);
  });

  test('default base candidates falling through to null is allowed (no explicit --base)', async () => {
    const created = await store.create(makeInput());
    // workDir is not a git repo → all default candidates fail, baseUsed=null,
    // but this is NOT an error. Handoff still succeeds (partial path due to
    // unverified ac and changed_files heuristic).
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    expect(result.baseUsed).toBeNull();
  });

  test('base priority: --base wins over started_at_sha', async () => {
    Bun.spawnSync(['git', 'init', '-q'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.email', 't@t'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'one'], {
      cwd: workDir,
      stdout: 'pipe',
    });
    const oneSha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: workDir, stdout: 'pipe' })
      .stdout.toString()
      .trim();
    Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'two'], {
      cwd: workDir,
      stdout: 'pipe',
    });
    const twoSha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: workDir, stdout: 'pipe' })
      .stdout.toString()
      .trim();
    const created = await store.create(makeInput());
    await store.update(created.id, (cur) => ({
      ...cur,
      started_at_sha: oneSha,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    const result = await writeWorkItemHandoff(workDir, store, created.id, { base: twoSha });
    expect(result.baseUsed).toBe(twoSha);
  });

  test('base priority: started_at_sha wins over default fallback when --base omitted', async () => {
    Bun.spawnSync(['git', 'init', '-q'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.email', 't@t'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'one'], {
      cwd: workDir,
      stdout: 'pipe',
    });
    const sha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: workDir, stdout: 'pipe' })
      .stdout.toString()
      .trim();
    const created = await store.create(makeInput());
    await store.update(created.id, (cur) => ({
      ...cur,
      started_at_sha: sha,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    // origin/main 등 fallback ref가 없는 임시 repo에서도 started_at_sha가 사용됨
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    expect(result.baseUsed).toBe(sha);
  });

  test('--head narrows diff to a past commit range, excluding later changes', async () => {
    Bun.spawnSync(['git', 'init', '-q'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.email', 't@t'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], {
      cwd: workDir,
      stdout: 'pipe',
    });
    const baseSha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: workDir, stdout: 'pipe' })
      .stdout.toString()
      .trim();
    await Bun.write(join(workDir, 'wave-1.txt'), 'one\n');
    Bun.spawnSync(['git', 'add', 'wave-1.txt'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'wave 1'], { cwd: workDir, stdout: 'pipe' });
    const headSha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: workDir, stdout: 'pipe' })
      .stdout.toString()
      .trim();
    await Bun.write(join(workDir, 'wave-2.txt'), 'two\n');
    Bun.spawnSync(['git', 'add', 'wave-2.txt'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'wave 2'], { cwd: workDir, stdout: 'pipe' });

    const created = await store.create(makeInput());
    await store.update(created.id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    const result = await writeWorkItemHandoff(workDir, store, created.id, {
      base: baseSha,
      head: headSha,
    });
    expect(result.completion.changed_files).toContain('wave-1.txt');
    expect(result.completion.changed_files).not.toContain('wave-2.txt');
  });

  test('--head with invalid ref throws InvalidHeadRefError', async () => {
    const created = await store.create(makeInput());
    let thrown: unknown;
    try {
      await writeWorkItemHandoff(workDir, store, created.id, {
        head: '__missing_head_ref__',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidHeadRefError);
  });

  test('replace (not union): stale changed_files give way to git collected on re-handoff', async () => {
    Bun.spawnSync(['git', 'init', '-q'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.email', 't@t'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], {
      cwd: workDir,
      stdout: 'pipe',
    });
    const initSha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: workDir, stdout: 'pipe' })
      .stdout.toString()
      .trim();
    await Bun.write(join(workDir, 'real-change.txt'), 'hello\n');
    Bun.spawnSync(['git', 'add', 'real-change.txt'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'real change'], {
      cwd: workDir,
      stdout: 'pipe',
    });

    const created = await store.create(makeInput());
    // work item에 가짜 entry를 박고 started_at_sha를 init commit으로 박는다.
    await store.update(created.id, (cur) => ({
      ...cur,
      started_at_sha: initSha,
      changed_files: ['never-existed.txt'],
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    // collected만 남고 가짜 entry는 사라진다.
    expect(result.completion.changed_files).toContain('real-change.txt');
    expect(result.completion.changed_files).not.toContain('never-existed.txt');
    const handoffText = await Bun.file(result.handoffPath).text();
    expect(handoffText).toContain('## 변경 파일');
    expect(handoffText).toContain('real-change.txt');
    expect(handoffText).not.toContain('never-existed.txt');
    // work-item.json도 갱신되어 가짜 entry가 사라져야 한다.
    const after = await store.get(created.id);
    expect(after.changed_files).not.toContain('never-existed.txt');
  });
});
