import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextCoverageNode, recordCoverageRound } from '~/core/coverage-loop';
import { coverageDryK } from '~/core/coverage-manager';
import { WorkItemStore } from '~/core/work-item-store';

/**
 * wi_260622vjo §8-4 — stakes-proportional DEPTH, breadth invariant (ac-4). The
 * termination depth K (consecutive dry rounds) scales with the tier derived from
 * the change's stakes: light=1, standard=2, full=3 (= TIER_DEPTH.maxRoundsPerNode).
 * A low-stakes sweep settles sooner; breadth (the node/category set) is unchanged.
 * No tierInputs → standard (K=2) = the existing default (ac-7).
 */
const passingNeutrality = {
  neutrality: { opponent_ran: true, verdict: 'accept' as const },
};
const lightTier = {
  changedFileCount: 1,
  interfaceChanged: false,
  risk: { non_local: false, irreversible: false, unaudited: false },
  large: false,
};

describe('depth dial — K maps to tier (wi_260622vjo §8-4)', () => {
  test('coverageDryK scales depth with the tier (breadth never reduced)', () => {
    expect(coverageDryK('light')).toBe(1);
    expect(coverageDryK('standard')).toBe(2);
    expect(coverageDryK('full')).toBe(3);
  });
});

describe('depth dial — termination timing follows the tier (§8-4)', () => {
  let repo: string;
  let WI: string;
  const NOW = new Date('2026-06-01T00:00:00.000Z');

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-cov-dial-'));
    const wi = await new WorkItemStore(repo).create(
      {
        title: 'depth dial test',
        source_request: 'stakes 비례 깊이',
        goal: 'low-stakes sweep는 더 얕게 종료',
        acceptance_criteria: [
          { id: 'ac-1', statement: 'depth scales', verdict: 'unverified', evidence: [] },
        ],
      },
      NOW,
    );
    WI = wi.id;
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test('a light-tier sweep terminates after a single dry round (K=1)', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI }); // seed root (no categories)
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-root',
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        axis_signals: passingNeutrality,
      },
      tierInputs: lightTier,
    });
    // root closed + 1 dry round → light K=1 → terminated.
    expect(r.terminated).toBe(true);
  });

  test('the same sweep at standard (no tierInputs) needs a second dry round (K=2, ac-7)', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI });
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-root',
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        axis_signals: passingNeutrality,
      },
      // no tierInputs → standard, K=2
    });
    // root closed but only 1 dry round (counter=1 < 2) → not yet terminated.
    expect(r.terminated).toBe(false);
  });
});

/**
 * wi_260622vjo ac-4 — the user can OVERRIDE intensity at entry. An explicit
 * `intensity` forces the tier (and thus depth K), winning over both the
 * standard default and the stakes-derived `tierInputs`. Breadth is untouched.
 * Absent `intensity` → unchanged behavior (the two tests above stay green, ac-7).
 */
describe('intensity override at entry (wi_260622vjo ac-4)', () => {
  let repo: string;
  let WI: string;
  const NOW = new Date('2026-06-01T00:00:00.000Z');

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-cov-intensity-'));
    const wi = await new WorkItemStore(repo).create(
      {
        title: 'intensity override test',
        source_request: '진입 강도 override',
        goal: '사용자가 강도를 진입 시 override',
        acceptance_criteria: [
          { id: 'ac-1', statement: 'override forces tier', verdict: 'unverified', evidence: [] },
        ],
      },
      NOW,
    );
    WI = wi.id;
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test('explicit intensity=light terminates after a single dry round (overrides standard default)', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI });
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-root',
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        axis_signals: passingNeutrality,
      },
      intensity: 'light', // override → K=1 (vs the standard default K=2)
    });
    expect(r.terminated).toBe(true);
  });

  test('explicit intensity=full beats stakes-derived light tierInputs (override precedence)', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI });
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-root',
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        axis_signals: passingNeutrality,
      },
      tierInputs: lightTier, // would derive light (K=1) on its own…
      intensity: 'full', // …but the explicit override wins → K=3, not yet dry after 1 round
    });
    expect(r.terminated).toBe(false);
  });

  test('entry intensity persists on coverage.json — later calls keep the tier without re-passing it (K-scale no longer evaporates)', async () => {
    // seed ONCE with the light override
    const seed = await nextCoverageNode({ repoRoot: repo, workItemId: WI, intensity: 'light' });
    expect(seed.action).toBe('interrogate');
    if (seed.action === 'interrogate') expect(seed.sweepAngles).toBe(1);

    // a later coverage-next WITHOUT intensity must stay light (persisted), not revert to standard
    const next = await nextCoverageNode({ repoRoot: repo, workItemId: WI });
    expect(next.action).toBe('interrogate');
    if (next.action === 'interrogate') {
      expect(next.tier).toBe('light');
      expect(next.sweepAngles).toBe(1);
    }

    // and a single dry round terminates (K=1 from the persisted light) — no intensity re-passed to round
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-root',
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        axis_signals: passingNeutrality,
      },
    });
    expect(r.terminated).toBe(true);
  });

  test('nextCoverageNode reflects the overridden tier in its result', async () => {
    const r = await nextCoverageNode({ repoRoot: repo, workItemId: WI, intensity: 'full' });
    expect(r.action).toBe('interrogate');
    if (r.action === 'interrogate') expect(r.tier).toBe('full');
  });

  test('nextCoverageNode surfaces sweepAngles per tier so the sweep effort scales (ac-4/ac-8)', async () => {
    // an explicit override on a call still wins per call → maps tier to angles
    const full = await nextCoverageNode({ repoRoot: repo, workItemId: WI, intensity: 'full' });
    expect(full.action).toBe('interrogate');
    if (full.action === 'interrogate') expect(full.sweepAngles).toBe(5);

    const light = await nextCoverageNode({ repoRoot: repo, workItemId: WI, intensity: 'light' });
    if (light.action === 'interrogate') expect(light.sweepAngles).toBe(1);

    // no override → standard = 3 angles (the existing default, ac-7). Checked on a
    // FRESH work item: this WI already persisted an entry override on its first seed,
    // so "no override" now means the persisted tier, not standard (the fix's whole point).
    const freshWi = await new WorkItemStore(repo).create(
      {
        title: 'standard default',
        source_request: '기본 강도',
        goal: '강도 미지정 시 standard',
        acceptance_criteria: [
          { id: 'ac-1', statement: 'standard default', verdict: 'unverified', evidence: [] },
        ],
      },
      NOW,
    );
    const std = await nextCoverageNode({ repoRoot: repo, workItemId: freshWi.id });
    if (std.action === 'interrogate') expect(std.sweepAngles).toBe(3);
  });
});
