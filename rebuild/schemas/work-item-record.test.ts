import { describe, expect, test } from 'bun:test';

import {
  REBUILD_RECORD_SCHEMA_VERSION,
  workItemRecord,
  workItemStatus,
} from './work-item-record';

const minimal = {
  schema_version: REBUILD_RECORD_SCHEMA_VERSION,
  id: 'wi_r1test01',
  title: '새 세대 최소 record',
  status: 'draft',
  acceptance_criteria: [],
  risks: [],
  created_at: '2026-07-23T00:00:00.000Z',
  updated_at: '2026-07-23T00:00:00.000Z',
  closed_at: null,
};

describe('workItemRecord (new-generation minimal schema)', () => {
  test('parses a minimal draft record', () => {
    const parsed = workItemRecord.parse(minimal);
    expect(parsed.id).toBe('wi_r1test01');
    expect(parsed.status).toBe('draft');
  });

  test('status enum preserves the lightweight-path lifecycle set', () => {
    expect(workItemStatus.options).toEqual([
      'draft',
      'in_progress',
      'blocked',
      'partial',
      'unverified',
      'done',
      'abandoned',
    ]);
  });

  test('acceptance criterion verdict is the 3-value contract — partial rejected', () => {
    const withPartial = {
      ...minimal,
      acceptance_criteria: [
        { id: 'ac1', statement: 's', verdict: 'partial', evidence: [] },
      ],
    };
    expect(workItemRecord.safeParse(withPartial).success).toBe(false);

    const withPass = {
      ...minimal,
      acceptance_criteria: [
        { id: 'ac1', statement: 's', verdict: 'pass', evidence: [] },
      ],
    };
    expect(workItemRecord.safeParse(withPass).success).toBe(true);
  });

  test('dropped legacy fields are rejected (strict schema)', () => {
    for (const dropped of [
      { runs: [] },
      { worktrees: [] },
      { handoff_path: 'x' },
      { owner_profile: 'p' },
      { child_ids: [] },
      { changed_files: [] },
      { started_at_sha: 'abc' },
      { started_untracked_baseline: [] },
      { source_request: 'req' },
    ]) {
      expect(workItemRecord.safeParse({ ...minimal, ...dropped }).success).toBe(
        false,
      );
    }
  });

  test('re-entry statuses (partial/unverified/blocked) require re_entry', () => {
    for (const status of ['partial', 'unverified', 'blocked'] as const) {
      const closedAt = status === 'blocked' ? null : minimal.closed_at;
      expect(
        workItemRecord.safeParse({ ...minimal, status, closed_at: closedAt })
          .success,
      ).toBe(false);
      expect(
        workItemRecord.safeParse({
          ...minimal,
          status,
          closed_at: closedAt,
          re_entry: { command: 'bun test rebuild/' },
        }).success,
      ).toBe(true);
    }
  });

  test('re_entry must carry a command or fresh evidence, not be empty', () => {
    expect(
      workItemRecord.safeParse({
        ...minimal,
        status: 'partial',
        re_entry: {},
      }).success,
    ).toBe(false);
    expect(
      workItemRecord.safeParse({
        ...minimal,
        status: 'partial',
        re_entry: { fresh_evidence_needed: ['bun test rebuild/ 재실행'] },
      }).success,
    ).toBe(true);
  });

  test('terminal statuses do not require re_entry', () => {
    expect(
      workItemRecord.safeParse({ ...minimal, status: 'done' }).success,
    ).toBe(true);
    expect(
      workItemRecord.safeParse({ ...minimal, status: 'abandoned' }).success,
    ).toBe(true);
  });

  test('github placeholder field is accepted but minimal (no behavior fields)', () => {
    expect(
      workItemRecord.safeParse({
        ...minimal,
        github: { repo: 'o/r', number: 79 },
      }).success,
    ).toBe(true);
    // legacy github_issue shape (project_item_id 등 동작 필드) is not the new field
    expect(
      workItemRecord.safeParse({
        ...minimal,
        github: { repo: 'o/r', number: 79, project_item_id: 'x' },
      }).success,
    ).toBe(false);
  });

  test('lineage/provenance additive-optional fields are accepted', () => {
    expect(
      workItemRecord.safeParse({
        ...minimal,
        follows: ['wi_prev'],
        discovered_by: 'wi_parent',
        risks: [{ statement: '되돌리기 어려움', severity: 'high' }],
        acceptance_criteria: [
          {
            id: 'ac1',
            statement: '원 기준',
            verdict: 'unverified',
            evidence: [],
            superseded: true,
          },
        ],
      }).success,
    ).toBe(true);
  });
});
