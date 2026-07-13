import { describe, expect, test } from 'bun:test';
import type { AutopilotDecision } from '~/core/autopilot-store';
import { type IntentQualityDeps, collectIntentQualityReport } from '~/core/intent-quality-doctor';
import type { WorkItemSummary } from '~/core/work-item-store';
import type { Autopilot } from '~/schemas/autopilot';
import type { IntentMetric } from '~/schemas/intent-metric';
import type { InterviewState } from '~/schemas/interview-state';
import type { QuestionRound } from '~/schemas/question-round';

function summary(id: string, over: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
    id,
    title: `wi ${id}`,
    status: 'in_progress',
    updated_at: '2026-06-08T00:00:00Z',
    ...over,
  };
}

// Minimal fixtures: collectIntentQualityReport only reads the fields below, so we
// build typed-narrow objects rather than full schema documents.
function interview(over: Partial<InterviewState['exit']> = {}, assumptions = 0): InterviewState {
  return {
    readiness: { score: 0.7, threshold: 0.6, critical_unresolved: [], gate: 'ready' },
    assumptions: Array.from({ length: assumptions }, () => ({})),
    exit: { questions_asked: 3, closure_mode: 'mutual_agreement', ...over },
  } as unknown as InterviewState;
}

function autopilot(kinds: string[], fixAttempts: number[] = []): Autopilot {
  return {
    nodes: kinds.map((kind, i) => ({ kind, attempts: { fix: fixAttempts[i] ?? 0, switch: 0 } })),
  } as unknown as Autopilot;
}

function decision(d: AutopilotDecision['decision']): AutopilotDecision {
  return {
    ts: '2026-06-08T00:00:00Z',
    node_id: 'n1',
    failure_class: 'fixable',
    decision: d,
    reason: 'x',
    attempts: { fix: 1, switch: 0 },
  };
}

function driftMetric(hops: ('H1' | 'H2' | 'H3')[]): IntentMetric {
  return {
    ts: '2026-06-08T00:00:00Z',
    work_item_id: 'wi_aaaaaaaa',
    kind: 'intent_drift',
    source: 'stop_hook',
    blocking_reasons: hops.map((h) => `${h}: scope grow`),
    advisories: [],
    hops,
  };
}

function questionRoundFixture(over: Partial<QuestionRound> = {}): QuestionRound {
  return {
    ts: '2026-06-19T05:00:00.000Z',
    work_item_id: 'wi_aaaaaaaa',
    round: 1,
    dry: false,
    generator_count: 3,
    selected: [
      {
        text: 'q',
        property: 'blind-spot',
        scores: { consensus: 2, quality: 0.8, necessity: 0.7, answer_value: 0.8 },
      },
    ],
    all_scored: [],
    ...over,
  } as QuestionRound;
}

function deps(over: Partial<IntentQualityDeps> = {}): IntentQualityDeps {
  return {
    listWorkItems: async () => [],
    readInterview: async () => null,
    readAutopilot: async () => null,
    readDecisions: async () => [],
    countHandoffRounds: async () => 0,
    readMetrics: async () => [],
    readQuestionRounds: async () => [],
    ...over,
  };
}

describe('collectIntentQualityReport', () => {
  test('no work items → empty rows, zeroed totals', async () => {
    const report = await collectIntentQualityReport(deps());
    expect(report.rows).toEqual([]);
    expect(report.totals.work_items).toBe(0);
    expect(report.totals.with_interview).toBe(0);
  });

  test('fully-instrumented item maps every signal onto its row', async () => {
    const report = await collectIntentQualityReport(
      deps({
        listWorkItems: async () => [summary('wi_aaaaaaaa')],
        readInterview: async () => interview({ questions_asked: 5 }, 2),
        readAutopilot: async () => autopilot(['implement', 'fix', 'fix'], [0, 1, 2]),
        readDecisions: async () => [
          decision('retry'),
          decision('switch_approach'),
          decision('escalate'),
        ],
        countHandoffRounds: async () => 1,
        readMetrics: async () => [driftMetric(['H1']), driftMetric(['H2'])],
      }),
    );
    const row = report.rows[0] as (typeof report.rows)[number];
    expect(row.questions_asked).toBe(5);
    expect(row.closure_mode).toBe('mutual_agreement');
    expect(row.readiness_score).toBe(0.7);
    expect(row.assumptions).toBe(2);
    expect(row.fix_nodes).toBe(2);
    expect(row.rework_attempts).toBe(3); // 0 + 1 + 2
    expect(row.retry_switch_decisions).toBe(2); // retry + switch_approach, not escalate
    expect(row.handoff_rounds).toBe(1);
    expect(row.drift_events).toBe(2);
    expect(row.post_cost).toBe(8); // drift 2 + rework 3 + retry/switch 2 + handoff 1
  });

  test('item without an interview → null process metrics, not counted in with_interview', async () => {
    const report = await collectIntentQualityReport(
      deps({
        listWorkItems: async () => [summary('wi_bbbbbbbb')],
        readAutopilot: async () => autopilot(['implement']),
      }),
    );
    const row = report.rows[0] as (typeof report.rows)[number];
    expect(row.questions_asked).toBeNull();
    expect(row.closure_mode).toBeNull();
    expect(row.readiness_score).toBeNull();
    expect(row.assumptions).toBe(0);
    expect(report.totals.with_interview).toBe(0);
  });

  test('totals aggregate across multiple work items', async () => {
    const map: Record<string, InterviewState | null> = {
      wi_aaaaaaaa: interview({ questions_asked: 2 }),
      wi_bbbbbbbb: null,
    };
    const report = await collectIntentQualityReport(
      deps({
        listWorkItems: async () => [summary('wi_aaaaaaaa'), summary('wi_bbbbbbbb')],
        readInterview: async (id) => map[id] ?? null,
        readAutopilot: async (id) =>
          id === 'wi_aaaaaaaa' ? autopilot(['fix'], [3]) : autopilot(['fix', 'fix'], [1, 1]),
        countHandoffRounds: async (id) => (id === 'wi_bbbbbbbb' ? 2 : 0),
      }),
    );
    expect(report.totals.work_items).toBe(2);
    expect(report.totals.with_interview).toBe(1);
    expect(report.totals.total_questions).toBe(2);
    expect(report.totals.total_fix_nodes).toBe(3); // 1 + 2
    expect(report.totals.total_rework_attempts).toBe(5); // 3 + 1 + 1
    expect(report.totals.total_handoff_rounds).toBe(2);
  });

  test('correlation buckets interviewed items by questions tercile (post_cost = drift here)', async () => {
    // q=1 → 3 drift, q=3 → 1 drift, q=9 → 0 drift: fewer questions carry more cost.
    const q: Record<string, number> = { wi_aaaaaaaa: 1, wi_bbbbbbbb: 3, wi_cccccccc: 9 };
    const drift: Record<string, IntentMetric[]> = {
      wi_aaaaaaaa: [driftMetric(['H1']), driftMetric(['H2']), driftMetric(['H3'])],
      wi_bbbbbbbb: [driftMetric(['H1'])],
      wi_cccccccc: [],
    };
    const report = await collectIntentQualityReport(
      deps({
        listWorkItems: async () => [
          summary('wi_aaaaaaaa'),
          summary('wi_bbbbbbbb'),
          summary('wi_cccccccc'),
        ],
        readInterview: async (id) => interview({ questions_asked: q[id] as number }),
        readMetrics: async (id) => drift[id] ?? [],
      }),
    );
    const [low, mid, high] = report.correlation as [
      (typeof report.correlation)[number],
      (typeof report.correlation)[number],
      (typeof report.correlation)[number],
    ];
    expect(low.quantile).toBe('low');
    expect(low.questions_range).toEqual([1, 1]);
    expect(low.avg_post_cost).toBe(3);
    expect(mid.avg_post_cost).toBe(1);
    expect(high.avg_post_cost).toBe(0);
    expect(report.totals.total_drift_events).toBe(4);
  });

  test('correlation emits three empty buckets when no item was interviewed', async () => {
    const report = await collectIntentQualityReport(
      deps({ listWorkItems: async () => [summary('wi_aaaaaaaa')] }),
    );
    expect(report.correlation.map((b) => b.quantile)).toEqual(['low', 'mid', 'high']);
    expect(report.correlation.every((b) => b.work_items === 0)).toBe(true);
    expect(report.correlation.every((b) => b.questions_range === null)).toBe(true);
  });

  test('question-value signal maps onto the row (증분 3 — 점수 소비)', async () => {
    const av = (v: number): QuestionRound['selected'] => [
      {
        text: 'q',
        property: 'blind-spot',
        scores: { consensus: 2, quality: 0.8, necessity: 0.7, answer_value: v },
      },
    ];
    const report = await collectIntentQualityReport(
      deps({
        listWorkItems: async () => [summary('wi_aaaaaaaa')],
        readQuestionRounds: async () => [
          questionRoundFixture({ round: 1, dry: false, selected: av(0.8) }),
          questionRoundFixture({ round: 2, dry: false, selected: av(0.4) }),
        ],
      }),
    );
    const row = report.rows[0] as (typeof report.rows)[number];
    expect(row.question_rounds).toBe(2);
    expect(row.question_selected).toBe(2);
    expect(row.question_dry_rounds).toBe(0);
    expect(row.question_mean_answer_value).toBeCloseTo(0.6, 5); // (0.8 + 0.4)/2
    expect(report.totals.total_question_rounds).toBe(2);
  });

  test('dry rounds counted; absent question rounds → zeroed signal, null mean (fail-open)', async () => {
    const withDry = await collectIntentQualityReport(
      deps({
        listWorkItems: async () => [summary('wi_aaaaaaaa')],
        readQuestionRounds: async () => [
          questionRoundFixture({ round: 1, dry: true, selected: [] }),
        ],
      }),
    );
    expect((withDry.rows[0] as (typeof withDry.rows)[number]).question_rounds).toBe(1);
    expect((withDry.rows[0] as (typeof withDry.rows)[number]).question_dry_rounds).toBe(1);
    expect((withDry.rows[0] as (typeof withDry.rows)[number]).question_selected).toBe(0);
    expect(
      (withDry.rows[0] as (typeof withDry.rows)[number]).question_mean_answer_value,
    ).toBeNull();

    const absent = await collectIntentQualityReport(
      deps({ listWorkItems: async () => [summary('wi_bbbbbbbb')] }),
    );
    expect((absent.rows[0] as (typeof absent.rows)[number]).question_rounds).toBe(0);
    expect((absent.rows[0] as (typeof absent.rows)[number]).question_mean_answer_value).toBeNull();
    expect(absent.totals.total_question_rounds).toBe(0);
  });
});
