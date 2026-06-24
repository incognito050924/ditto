import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextCoverageNode, recordCoverageRound } from '~/core/coverage-loop';
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

// ac-2 — a category may be skipped only as a recorded, justified decision: closing
// a category in a non-resolved state (out_of_scope / user_owned) without a reason
// is rejected (no silent skip); the reason is recorded on the node (auditable).
describe('justified category skip (wi_260622vjo §8-2 / ac-2)', () => {
  const AUTH = `${CATEGORY_NODE_PREFIX}authentication`;

  test('skipping a category out_of_scope without a reason is rejected — no silent skip', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: { node_id: AUTH, admissibleBranchesAdded: 0, close_as: 'out_of_scope' },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(false);
    expect(r.reasons.join(' ')).toContain('reason');

    // the category stays OPEN — it cannot be silently passed.
    const node = (await new CoverageStore(repo).getMap(WI)).nodes.find((n) => n.id === AUTH);
    expect(node?.state).toBe('open');
  });

  test('a skipped category records its justification on the node (auditable)', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    const reason = '이 변경은 인증 경로를 건드리지 않음 — 읽기 전용 내부 계산';
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: AUTH,
        admissibleBranchesAdded: 0,
        close_as: 'out_of_scope',
        close_reason: reason,
        // A non-resolved close now also requires the surviving risk (residual_risk
        // gate); supply one so this close_reason-recording assertion still reaches a
        // closed node. The residual_risk record itself is asserted separately below.
        residual_risk: '잔여: 인증 가정이 외부 우회 경로에서 깨질 수 있음',
      },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(true);

    const node = (await new CoverageStore(repo).getMap(WI)).nodes.find((n) => n.id === AUTH);
    expect(node?.state).toBe('out_of_scope');
    expect(node?.close_reason).toBe(reason);
  });

  test('resolving a category (swept, not skipped) does not require a skip reason', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: AUTH,
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        axis_signals: { neutrality: { opponent_ran: true, verdict: 'accept' } },
      },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(true);
  });
});

// surviving-risk self-description gap: a non-resolved category close records WHY it
// was skipped (close_reason) but not WHAT RISK survives that skip. residual_risk is a
// separate REQUIRED field for non-resolved closes (out_of_scope / user_owned),
// mirroring close_reason's fail-closed gate; a resolved (swept) close does not require
// it (the sweep settled the risk).
describe('surviving-risk on a skipped category (residual_risk)', () => {
  const AUTH = `${CATEGORY_NODE_PREFIX}authentication`;
  const REASON = '이 변경은 인증 경로를 건드리지 않음 — 읽기 전용 내부 계산';
  const RISK = '잔여: 외부 호출자가 우회 경로로 들어오면 인증 가정이 깨질 수 있음';

  test('skipping a category with a close_reason but NO residual_risk is rejected — surviving risk must be named', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: AUTH,
        admissibleBranchesAdded: 0,
        close_as: 'out_of_scope',
        close_reason: REASON,
      },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(false);
    expect(r.reasons.join(' ')).toContain('residual_risk');

    // the category stays OPEN — it cannot be closed without naming the surviving risk.
    const node = (await new CoverageStore(repo).getMap(WI)).nodes.find((n) => n.id === AUTH);
    expect(node?.state).toBe('open');
  });

  test('a skipped category with both close_reason AND residual_risk closes and records both (auditable)', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: AUTH,
        admissibleBranchesAdded: 0,
        close_as: 'out_of_scope',
        close_reason: REASON,
        residual_risk: RISK,
      },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(true);

    const node = (await new CoverageStore(repo).getMap(WI)).nodes.find((n) => n.id === AUTH);
    expect(node?.state).toBe('out_of_scope');
    expect(node?.close_reason).toBe(REASON);
    expect(node?.residual_risk).toBe(RISK);
  });

  test('resolving a category (swept, not skipped) does not require a residual_risk', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: AUTH,
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        axis_signals: { neutrality: { opponent_ran: true, verdict: 'accept' } },
      },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(true);
  });
});
