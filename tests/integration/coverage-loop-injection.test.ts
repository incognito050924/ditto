import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextCoverageNode } from '~/core/coverage-loop';
import { farFieldLenses } from '~/core/coverage-taxonomy';
import { WorkItemStore } from '~/core/work-item-store';

/**
 * wi_260622vjo §8-1 — far-field taxonomy injection seam. Before this change the
 * plan-stage sweep handed the fresh judge `cross_cutting_constraints:[]` (an empty
 * slot), so it surfaced only risks it happened to recall. Now `nextCoverageNode`
 * seeds the judge input with the floor lenses so every far-field category is in
 * view. This locks that wiring at the loop's entry point.
 */
let repo: string;
let WI: string;
const NOW = new Date('2026-06-01T00:00:00.000Z');

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-cov-inject-'));
  const wi = await new WorkItemStore(repo).create(
    {
      title: 'injection test',
      source_request: '고객 계좌조회처럼 기능적으로 먼 도메인 결합을 sweep이 보게 한다',
      goal: 'far-field 카테고리가 sweep judge input에 시딩된다',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'lenses injected', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  WI = wi.id;
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('far-field injection seam (wi_260622vjo §8-1)', () => {
  test('the seeded judge input carries the full floor instead of an empty slot', async () => {
    const first = await nextCoverageNode({ repoRoot: repo, workItemId: WI });
    expect(first.action).toBe('interrogate');
    if (first.action !== 'interrogate') return;

    // The gap closed: cross_cutting_constraints is the floor, not [].
    expect(first.judgeInput.cross_cutting_constraints).toEqual(farFieldLenses());
    expect(first.judgeInput.cross_cutting_constraints.length).toBe(19);
  });

  test('the injected lenses include the far-field domains the user motivated (auth/authz)', async () => {
    const first = await nextCoverageNode({ repoRoot: repo, workItemId: WI });
    if (first.action !== 'interrogate') throw new Error('expected interrogate');
    const joined = first.judgeInput.cross_cutting_constraints.join('\n');
    expect(joined).toContain('인증');
    expect(joined).toContain('권한');
  });
});
