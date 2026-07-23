import { describe, expect, test } from 'bun:test';

import { intentArtifact } from './intent-artifact';

const valid = {
  work_item_id: 'wi_x',
  root_goal: '저장 계층 위에 완료 게이트를 세운다',
  criteria: [
    {
      id: 'ac1',
      statement: '테스트가 green이다',
      oracle: {
        criterion_id: 'ac1',
        statement: 'bun test rebuild/ exit 0',
        verification_method: 'dynamic_test',
        direction: 'forward',
        maps_to: { kind: 'ac', ref: 'ac1' },
      },
    },
  ],
  risks: [{ statement: '경로 회귀 가능성', severity: 'medium' }],
};

describe('intentArtifact — 하나의 의도=하나의 단위, AC↔oracle 수렴', () => {
  test('parses a well-formed artifact bound to a single work item', () => {
    const parsed = intentArtifact.parse(valid);
    expect(parsed.work_item_id).toBe('wi_x');
    expect(parsed.criteria).toHaveLength(1);
  });

  test('criteria must be non-empty — an intent without ACs is not an intent', () => {
    expect(
      intentArtifact.safeParse({ ...valid, criteria: [] }).success,
    ).toBe(false);
  });

  test('every criterion carries its own oracle with a matching criterion_id (수렴)', () => {
    // oracle 없는 AC 금지
    expect(
      intentArtifact.safeParse({
        ...valid,
        criteria: [{ id: 'ac1', statement: 's' }],
      }).success,
    ).toBe(false);
    // criterion_id 불일치 금지
    expect(
      intentArtifact.safeParse({
        ...valid,
        criteria: [
          {
            ...valid.criteria[0],
            oracle: { ...valid.criteria[0]!.oracle, criterion_id: 'ac9' },
          },
        ],
      }).success,
    ).toBe(false);
  });

  test('duplicate criterion ids are refused', () => {
    expect(
      intentArtifact.safeParse({
        ...valid,
        criteria: [valid.criteria[0], valid.criteria[0]],
      }).success,
    ).toBe(false);
  });

  test('risks are optional but must be well-formed declared risks when present', () => {
    expect(
      intentArtifact.safeParse({ ...valid, risks: [] }).success,
    ).toBe(true);
    expect(
      intentArtifact.safeParse({ ...valid, risks: [{ statement: '' }] })
        .success,
    ).toBe(false);
  });
});
