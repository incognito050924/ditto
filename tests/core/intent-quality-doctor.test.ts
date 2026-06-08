import { describe, expect, test } from 'bun:test';
import type { AutopilotDecision } from '~/core/autopilot-store';
import { type IntentQualityDeps, collectIntentQualityReport } from '~/core/intent-quality-doctor';
import type { WorkItemSummary } from '~/core/work-item-store';
import type { Autopilot } from '~/schemas/autopilot';
import type { InterviewState } from '~/schemas/interview-state';

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

function deps(over: Partial<IntentQualityDeps> = {}): IntentQualityDeps {
  return {
    listWorkItems: async () => [],
    readInterview: async () => null,
    readAutopilot: async () => null,
    readDecisions: async () => [],
    countHandoffRounds: async () => 0,
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
      }),
    );
    const row = report.rows[0];
    expect(row.questions_asked).toBe(5);
    expect(row.closure_mode).toBe('mutual_agreement');
    expect(row.readiness_score).toBe(0.7);
    expect(row.assumptions).toBe(2);
    expect(row.fix_nodes).toBe(2);
    expect(row.rework_attempts).toBe(3); // 0 + 1 + 2
    expect(row.retry_switch_decisions).toBe(2); // retry + switch_approach, not escalate
    expect(row.handoff_rounds).toBe(1);
  });

  test('item without an interview → null process metrics, not counted in with_interview', async () => {
    const report = await collectIntentQualityReport(
      deps({
        listWorkItems: async () => [summary('wi_bbbbbbbb')],
        readAutopilot: async () => autopilot(['implement']),
      }),
    );
    const row = report.rows[0];
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
});
