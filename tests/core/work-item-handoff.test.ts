import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWorkItemHandoff } from '~/core/work-item-handoff';
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

  test('handoff renders changed_files section when present', async () => {
    const created = await store.create(makeInput());
    await store.update(created.id, (cur) => ({
      ...cur,
      changed_files: ['src/foo.ts', 'src/bar.ts'],
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    const handoffText = await Bun.file(result.handoffPath).text();
    expect(handoffText).toContain('## 변경 파일');
    expect(handoffText).toContain('src/foo.ts');
    expect(handoffText).toContain('src/bar.ts');
  });
});
