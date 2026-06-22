import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextCoverageNode } from '~/core/coverage-loop';
import { CoverageStore } from '~/core/coverage-store';
import { CATEGORY_NODE_PREFIX } from '~/core/coverage-taxonomy';
import { WorkItemStore } from '~/core/work-item-store';

/**
 * wi_260622vjo §8-2 — category-complete termination. With seedCategories on, the
 * first call seeds the root + one node per floor category, so termination (the
 * existing `allClosed` predicate) requires every category swept (ac-2). Off by
 * default → the existing root-only tree is unchanged (ac-7).
 */
let repo: string;
let WI: string;
const NOW = new Date('2026-06-01T00:00:00.000Z');

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-cov-seed-'));
  const wi = await new WorkItemStore(repo).create(
    {
      title: 'seeding test',
      source_request: 'far-field 카테고리를 sweep 노드로 시딩',
      goal: '모든 카테고리가 명시 sweep돼야 종료',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'categories seeded', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  WI = wi.id;
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('category seeding (wi_260622vjo §8-2)', () => {
  test('seedCategories:true seeds root + one node per floor category and schedules a category', async () => {
    const first = await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    expect(first.action).toBe('interrogate');
    if (first.action !== 'interrogate') return;

    const map = await new CoverageStore(repo).getMap(WI);
    // root + 19 category nodes
    expect(map.nodes.filter((n) => n.id.startsWith(CATEGORY_NODE_PREFIX)).length).toBe(19);
    expect(map.nodes.length).toBe(20);

    // root has open children → it is deferred; the leaf frontier is a category.
    expect(first.node.id.startsWith(CATEGORY_NODE_PREFIX)).toBe(true);
  });

  test('default (no seedCategories) keeps the existing root-only tree (ac-7)', async () => {
    const first = await nextCoverageNode({ repoRoot: repo, workItemId: WI });
    expect(first.action).toBe('interrogate');
    if (first.action !== 'interrogate') return;
    expect(first.node.id).toBe('cov-root');

    const map = await new CoverageStore(repo).getMap(WI);
    expect(map.nodes.length).toBe(1);
  });
});
