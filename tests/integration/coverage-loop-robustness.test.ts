import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextCoverageNode, recordCoverageRound } from '~/core/coverage-loop';
import { CoverageStore } from '~/core/coverage-store';
import { CATEGORY_NODE_PREFIX } from '~/core/coverage-taxonomy';
import { WorkItemStore } from '~/core/work-item-store';

// wi_260625txs — coverage runtime store robustness. The far-field cost-measurement
// sweep adversarially confirmed two latent defects in recordCoverageRound's
// persistence: (B) appended derived/discovered nodes are not deduped before
// addNode, so a retried/replayed round with the same payload throws
// "duplicate coverage node id" (non-idempotent retry). This drives that fix.
let repo: string;
let WI: string;
const NOW = new Date('2026-06-01T00:00:00.000Z');

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-cov-robust-'));
  const wi = await new WorkItemStore(repo).create(
    {
      title: 'robustness test',
      source_request: 'coverage round 재시도 멱등',
      goal: '같은 라운드 재기록이 throw하지 않아야 한다',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'idempotent retry', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  WI = wi.id;
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('recordCoverageRound idempotent retry (wi_260625txs, bug B)', () => {
  test('re-recording a round with the same derived node does not throw and does not duplicate', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    const AUTH = `${CATEGORY_NODE_PREFIX}authentication`;
    const derived = {
      id: 'cov-auth-sub',
      parent_id: AUTH,
      label: 'derived sub-scope',
      origin: 'derived' as const,
      depth_weight: 0.5,
    };

    // first round appends the derived node
    const r1 = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: AUTH,
        admissibleBranchesAdded: 1,
        derived_nodes: [derived],
        discovered_nodes: [],
      },
    });
    expect(r1.terminated).toBe(false);

    // retry/replay with the SAME payload must be idempotent — not throw (addNode
    // would otherwise reject the now-persisted id) and not duplicate the node.
    const r2 = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: AUTH,
        admissibleBranchesAdded: 1,
        derived_nodes: [derived],
        discovered_nodes: [],
      },
    });
    expect(r2.terminated).toBe(false);

    const map = await new CoverageStore(repo).getMap(WI);
    expect(map.nodes.filter((n) => n.id === 'cov-auth-sub')).toHaveLength(1);
  });
});
