import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LegacyRecordReadOnlyError, listBacklog } from './legacy';
import {
  createWorkItem,
  finalizeWorkItem,
  loadWorkItem,
  reopenWorkItem,
  transitionWorkItem,
} from './store';

/**
 * 옛 세대 record.json의 사실적 사본(fixture) — drop된 9필드·4값 verdict·
 * github_issue 동작 필드까지 포함한다. 실기록은 테스트에서 읽지 않는다.
 */
const legacyFixture = {
  schema_version: '4',
  id: 'wi_legacy01',
  title: '옛 세대 작업',
  source_request: '옛 요청',
  goal: '옛 목표',
  acceptance_criteria: [
    {
      id: 'ac1',
      statement: '옛 기준',
      verdict: 'partial', // 은퇴한 4값 verdict — 읽기는 관용
      evidence: [{ kind: 'command', command: 'bun test', summary: 'ok' }],
    },
  ],
  status: 'done',
  owner_profile: 'default',
  child_ids: [],
  changed_files: ['src/x.ts'],
  worktrees: [],
  github_issue: { repo: 'o/r', number: 5, project_item_id: 'PVTI_x' },
  risks: [],
  runs: [{ run_id: 'run1' }],
  handoff_path: '.ditto/handoff/old.md',
  started_at_sha: 'abc123',
  started_untracked_baseline: [],
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-02T00:00:00.000Z',
  closed_at: '2026-06-02T00:00:00.000Z',
};

async function repoWithLegacy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ditto-legacy-'));
  const dir = join(root, '.ditto', 'work-items', legacyFixture.id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'record.json'),
    JSON.stringify(legacyFixture, null, 2),
    'utf8',
  );
  return root;
}

describe('legacy records are read-only heritage', () => {
  test('loadWorkItem refuses a legacy record explicitly (not a parse error)', async () => {
    const root = await repoWithLegacy();
    await expect(loadWorkItem(root, 'wi_legacy01')).rejects.toThrow(
      LegacyRecordReadOnlyError,
    );
  });

  test('reopen of a legacy record is explicitly refused', async () => {
    const root = await repoWithLegacy();
    await expect(reopenWorkItem(root, 'wi_legacy01', 'me')).rejects.toThrow(
      LegacyRecordReadOnlyError,
    );
  });
});

describe('listBacklog — 두 세대 합산 뷰', () => {
  test('merges legacy and rebuild generations into one view', async () => {
    const root = await repoWithLegacy();
    await createWorkItem(root, { id: 'wi_new01', title: '새 세대 작업' });
    await transitionWorkItem(root, 'wi_new01', {
      to: 'in_progress',
      actor: 'me',
    });

    const backlog = await listBacklog(root);
    const byId = new Map(backlog.map((e) => [e.id, e]));

    const legacy = byId.get('wi_legacy01');
    expect(legacy?.generation).toBe('legacy');
    expect(legacy?.status).toBe('done'); // 옛 status 문자열 그대로 (관용)
    expect(legacy?.title).toBe('옛 세대 작업');

    const fresh = byId.get('wi_new01');
    expect(fresh?.generation).toBe('rebuild');
    expect(fresh?.status).toBe('in_progress'); // 이벤트 fold 반영
  });

  test('rebuild entries reflect terminal status from events', async () => {
    const root = await repoWithLegacy();
    await createWorkItem(root, { id: 'wi_new02', title: 'd' });
    await finalizeWorkItem(root, 'wi_new02', { status: 'done', actor: 'me' });
    const backlog = await listBacklog(root);
    expect(backlog.find((e) => e.id === 'wi_new02')?.status).toBe('done');
  });

  test('a malformed legacy record degrades to an id-only entry instead of killing the view', async () => {
    const root = await repoWithLegacy();
    const dir = join(root, '.ditto', 'work-items', 'wi_broken');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'record.json'), '{"no_id": true}', 'utf8');

    const backlog = await listBacklog(root);
    const broken = backlog.find((e) => e.id === 'wi_broken');
    expect(broken?.generation).toBe('legacy');
    expect(broken?.status).toBe('unknown');
    // 나머지 정상 항목은 그대로 살아 있다
    expect(backlog.some((e) => e.id === 'wi_legacy01')).toBe(true);
  });

  test('empty work-items dir yields an empty backlog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ditto-empty-'));
    expect(await listBacklog(root)).toEqual([]);
  });
});
