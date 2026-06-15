import { describe, expect, test } from 'bun:test';
import { REVIEW_ROLES, aggregateUnitReview, planUnitReview } from '~/acg/review/unit-review';
import { acgReviewGraph } from '~/schemas/acg-review-graph';
import type { ReviewerOutput } from '~/schemas/reviewer-output';

// WU-5 (80-plan §9, ac-11/12/13). `ditto review --scope <unit>` is the UNIT-scoped
// sibling of `ditto acg-review` (work-item scoped): it resolves the unit file set
// (shared WU-4 resolver), DECOMPOSES the standing-code file set into batches that
// BOTH the reviewer and the security-reviewer roles operate over (the LLM runs are
// autopilot-dispatched; this is the deterministic scoping/batching/aggregation seam),
// and AGGREGATES the reviewer-output + security-reviewer-output into ONE acg-review.json.
//
// ac-13 / PM-5: a large unit must batch with progress and account for EVERY file —
// 0 files silently dropped. A drop (file cap) must be LOGGED, never silent.

describe('planUnitReview — batch decomposition + both-role coverage (ac-11, ac-13)', () => {
  const files = Array.from({ length: 7 }, (_, i) => `src/core/f${i}.ts`);

  test('ac-11: the plan covers BOTH reviewer and security-reviewer over the full file set', () => {
    const plan = planUnitReview(files, { batchSize: 3 });
    expect(REVIEW_ROLES).toEqual(['code-reviewer', 'security-reviewer']);
    // Both roles operate over the unit file set.
    expect(plan.roles).toEqual(['code-reviewer', 'security-reviewer']);
    // Every batch carries both roles.
    for (const batch of plan.batches) {
      expect(batch.roles).toEqual(['code-reviewer', 'security-reviewer']);
    }
  });

  test('ac-13: large unit decomposes into batches with progress (batch index / total)', () => {
    const plan = planUnitReview(files, { batchSize: 3 });
    // 7 files / batch 3 → 3 batches (3,3,1).
    expect(plan.batches.length).toBe(3);
    expect(plan.batches.map((b) => b.files.length)).toEqual([3, 3, 1]);
    expect(plan.batches.map((b) => b.index)).toEqual([1, 2, 3]);
    for (const b of plan.batches) expect(b.total).toBe(3);
    expect(plan.progress).toBe('3/3 batches'); // all batches accounted
  });

  test('ac-13: every file is accounted for — reviewed + dropped == resolved (0 silent drops)', () => {
    const plan = planUnitReview(files, { batchSize: 3 });
    expect(plan.resolvedCount).toBe(7);
    expect(plan.reviewedCount).toBe(7);
    expect(plan.dropped).toEqual([]); // no cap → nothing dropped
    expect(plan.reviewedCount + plan.dropped.length).toBe(plan.resolvedCount);
  });

  test('ac-13: a file cap (PM-5) drops the overflow but LOGS every dropped file (no silent truncation)', () => {
    const plan = planUnitReview(files, { batchSize: 3, fileLimit: 4 });
    expect(plan.resolvedCount).toBe(7);
    expect(plan.reviewedCount).toBe(4);
    // 3 overflow files are LOGGED as dropped, not silently removed.
    expect(plan.dropped.length).toBe(3);
    expect(plan.dropped).toEqual(['src/core/f4.ts', 'src/core/f5.ts', 'src/core/f6.ts']);
    // The invariant the AC names: reviewed + dropped == resolved.
    expect(plan.reviewedCount + plan.dropped.length).toBe(plan.resolvedCount);
  });
});

const baseOutput = (overrides: Partial<ReviewerOutput> = {}): ReviewerOutput => ({
  schema_version: '0.1.0',
  id: 'rv_abcd1234',
  work_item_id: 'wi_abcd1234',
  kind: 'code-reviewer',
  reviewer: 'reviewer-profile',
  different_provider_than_generator: false,
  started_at: '2026-06-03T00:00:00Z',
  verdict: 'partial',
  evidence: [],
  findings: [],
  unverified: [],
  recommended_next_action: 'fix it',
  ...overrides,
});

describe('aggregateUnitReview — one unit ledger from reviewer + security-reviewer (ac-11, ac-12)', () => {
  test('ac-11: aggregates BOTH role outputs into ONE acgReviewGraph (reuses the pure adapter)', () => {
    const codeReview = baseOutput({
      kind: 'code-reviewer',
      findings: [{ severity: 'medium', file: 'src/core/cart.ts', reason: 'unguarded null' }],
    });
    const securityReview = baseOutput({
      kind: 'security-reviewer',
      findings: [{ severity: 'high', file: 'src/core/auth.ts', reason: 'missing tenant check' }],
    });

    const graph = aggregateUnitReview([codeReview, securityReview]);

    expect(acgReviewGraph.safeParse(graph).success).toBe(true);
    const byPath = Object.fromEntries(graph.files.map((f) => [f.path, f.risk]));
    expect(byPath['src/core/cart.ts']).toBe('medium'); // from code-reviewer
    expect(byPath['src/core/auth.ts']).toBe('high'); // from security-reviewer
    // high-risk auth finding is on the human review set.
    expect(graph.human_review_set).toContain('src/core/auth.ts');
  });

  test('ac-12: a high-risk finding with NO evidence remains un-evidenced (Stop will block)', () => {
    const securityReview = baseOutput({
      kind: 'security-reviewer',
      findings: [{ severity: 'critical', file: 'src/core/auth.ts', reason: 'auth bypass' }],
    });
    const graph = aggregateUnitReview([securityReview]);
    const highNoEvidence = graph.files.filter((f) => f.risk === 'high' && f.evidence === undefined);
    expect(highNoEvidence.length).toBe(1);
    expect(highNoEvidence[0]?.path).toBe('src/core/auth.ts');
  });
});
