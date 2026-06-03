import { describe, expect, test } from 'bun:test';
import { projectReviewerOutputToAcgReview } from '~/acg/review/acg-review-adapter';
import { acgReviewGraph } from '~/schemas/acg-review-graph';
import { type ReviewerOutput, reviewerOutput } from '~/schemas/reviewer-output';

// WU-4 acceptance: the ReviewGraph ↔ reviewer-output adapter (D3) projects a
// reviewer-output into the acg_review view (acg.review-graph.v1) without mutating
// reviewer-output. Per D3 the adapter only READS the reviewer-output type.

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
  recommended_next_action: 'fix the auth check',
  ...overrides,
});

describe('acg-review-adapter (WU-4, D3)', () => {
  test('mixed-severity findings + unverified[] project to a valid acgReviewGraph', () => {
    const output = baseOutput({
      findings: [
        { severity: 'critical', file: 'src/auth/login.ts', reason: 'missing tenant check' },
        { severity: 'high', file: 'src/payment/charge.ts', reason: 'no idempotency key' },
        { severity: 'medium', file: 'src/service/cart.ts', reason: 'unguarded null' },
        { severity: 'low', file: 'src/util/format.ts', reason: 'naming nit' },
        { severity: 'info', file: 'src/util/log.ts', reason: 'noisy log' },
      ],
      unverified: [{ item: 'concurrency under load', reason: 'no load test available' }],
    });

    const graph = projectReviewerOutputToAcgReview(output);

    // The output validates against acgReviewGraph (parse succeeds).
    expect(acgReviewGraph.safeParse(graph).success).toBe(true);

    // severity→risk mapping.
    const byPath = Object.fromEntries(graph.files.map((f) => [f.path, f.risk]));
    expect(byPath['src/auth/login.ts']).toBe('high'); // critical→high
    expect(byPath['src/payment/charge.ts']).toBe('high'); // high→high
    expect(byPath['src/service/cart.ts']).toBe('medium'); // medium→medium
    expect(byPath['src/util/format.ts']).toBe('low'); // low→low
    expect(byPath['src/util/log.ts']).toBe('low'); // info→low

    // human_review_set = high-risk OR unresolved (path|journey_id).
    expect(graph.human_review_set).toContain('src/auth/login.ts');
    expect(graph.human_review_set).toContain('src/payment/charge.ts');
    expect(graph.human_review_set).toContain('concurrency under load'); // unresolved
    expect(graph.human_review_set).not.toContain('src/service/cart.ts'); // medium, not high
  });

  test('unverified items become files with unresolved=true and NO evidence.kind=unresolved (OBJ-53)', () => {
    const output = baseOutput({
      unverified: [{ item: 'race in scheduler', reason: 'cannot reproduce deterministically' }],
    });

    const graph = projectReviewerOutputToAcgReview(output);
    const entry = graph.files.find((f) => f.path === 'race in scheduler');
    expect(entry).toBeDefined();
    // unresolved is a separate boolean flag, not an evidence kind.
    expect(entry?.unresolved).toBe(true);
    expect(entry?.evidence).toBeUndefined();
  });

  test('a ui/user_journey file is identified by journey_id (schema accepts it)', () => {
    // Construct the acg_review object directly: the adapter projects from
    // reviewer-output (which has no journey role), so this asserts the binding
    // shape the schema accepts for journey-role entries.
    const journeyGraph = {
      kind: 'acg.review-graph.v1' as const,
      files: [
        {
          journey_id: 'jrn-checkout',
          role: 'user_journey' as const,
          risk: 'high' as const,
          risk_reason: 'checkout flow touched without e2e',
          unresolved: true,
        },
      ],
      human_review_set: ['jrn-checkout'],
    };
    expect(acgReviewGraph.safeParse(journeyGraph).success).toBe(true);
  });

  test('round-trip: acgReviewGraph → JSON → parse is lossless', () => {
    const output = baseOutput({
      findings: [
        { severity: 'high', file: 'src/auth/login.ts', reason: 'missing tenant check' },
        { severity: 'medium', file: 'src/service/cart.ts', reason: 'unguarded null' },
      ],
      unverified: [{ item: 'concurrency under load', reason: 'no load test' }],
    });

    const graph = projectReviewerOutputToAcgReview(output);
    const roundTripped = acgReviewGraph.parse(JSON.parse(JSON.stringify(graph)));
    expect(roundTripped).toEqual(graph);
  });

  test('D3: reviewer-output schema still parses its own valid example (unchanged)', () => {
    // Regression proof that reviewer-output.ts is untouched: it parses a valid
    // reviewer-output exactly as before. The adapter only reads the type.
    expect(reviewerOutput.safeParse(baseOutput()).success).toBe(true);
  });
});
