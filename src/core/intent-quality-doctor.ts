import type { Autopilot } from '~/schemas/autopilot';
import type { ClosureMode } from '~/schemas/convergence';
import type { InterviewState } from '~/schemas/interview-state';
import { type AutopilotDecision, AutopilotStore } from './autopilot-store';
import { HandoffStore } from './handoff-store';
import { InterviewStore } from './interview-store';
import { WorkItemStore, type WorkItemSummary } from './work-item-store';

/**
 * intent-quality doctor (measurement-infra P1) — aggregates the deep-interview
 * INTENT signal (how much was asked, how it closed, how ready) against the
 * downstream REWORK signal (fix nodes, retry/switch decisions, handoff rounds)
 * per work item, from data that is ALREADY persisted. No new instrumentation:
 * interview-state.json + autopilot.json + autopilot-decisions.jsonl + active
 * handoffs are read as-is.
 *
 * The goal is to answer "are few questions thrift or neglect?" with data — the
 * process metric (questions_asked) sitting next to the outcome metric (rework).
 * The intent-drift OUTCOME metric is volatile today (stderr-only); P3 persists
 * it and folds drift_events + the questions×cost correlation into this report.
 */
export interface IntentQualityRow {
  work_item_id: string;
  title: string;
  status: WorkItemSummary['status'];
  /** Questions actually asked in the deep interview; null when no interview ran. */
  questions_asked: number | null;
  /** How axis-1 closed; null when no interview ran. */
  closure_mode: ClosureMode | null;
  /** Self-reported readiness score [0..1]; null when no interview ran. */
  readiness_score: number | null;
  readiness_gate: 'blocked' | 'ready' | null;
  /** Assumptions recorded in lieu of an answer (a thrift-vs-neglect signal). */
  assumptions: number;
  /** Autopilot nodes of kind 'fix' (rework introduced after the plan). */
  fix_nodes: number;
  /** Sum of attempts.fix across nodes (how hard the rework churned). */
  rework_attempts: number;
  /** Driver decisions to retry or switch approach (rework signal). */
  retry_switch_decisions: number;
  /** Active handoff rounds for this work item (continuation churn). */
  handoff_rounds: number;
}

export interface IntentQualityTotals {
  work_items: number;
  with_interview: number;
  total_questions: number;
  total_fix_nodes: number;
  total_rework_attempts: number;
  total_retry_switch_decisions: number;
  total_handoff_rounds: number;
}

export interface IntentQualityReport {
  rows: IntentQualityRow[];
  totals: IntentQualityTotals;
}

export interface IntentQualityDeps {
  listWorkItems(): Promise<WorkItemSummary[]>;
  /** Read interview-state.json, or null when absent/unreadable. */
  readInterview(workItemId: string): Promise<InterviewState | null>;
  /** Read autopilot.json, or null when absent/unreadable. */
  readAutopilot(workItemId: string): Promise<Autopilot | null>;
  /** Read autopilot-decisions.jsonl (empty when absent). */
  readDecisions(workItemId: string): Promise<AutopilotDecision[]>;
  /** Active handoff rounds owned by this work item. */
  countHandoffRounds(workItemId: string): Promise<number>;
}

/** Wire the real stores. Each reader is fail-open: a missing sidecar is null/0, never a throw. */
export function defaultIntentQualityDeps(repoRoot: string): IntentQualityDeps {
  const workItems = new WorkItemStore(repoRoot);
  const interviews = new InterviewStore(repoRoot);
  const autopilots = new AutopilotStore(repoRoot);
  const handoffs = new HandoffStore(repoRoot);
  return {
    listWorkItems: () => workItems.list(),
    readInterview: async (id) => ((await interviews.exists(id)) ? interviews.get(id) : null),
    readAutopilot: async (id) => ((await autopilots.exists(id)) ? autopilots.get(id) : null),
    readDecisions: (id) => autopilots.readDecisions(id),
    countHandoffRounds: async (id) =>
      (await handoffs.listActive()).filter((h) => h.handoff.work_item_id === id).length,
  };
}

function buildRow(
  summary: WorkItemSummary,
  interview: InterviewState | null,
  graph: Autopilot | null,
  decisions: AutopilotDecision[],
  handoffRounds: number,
): IntentQualityRow {
  const fixNodes = graph ? graph.nodes.filter((n) => n.kind === 'fix') : [];
  const reworkAttempts = graph
    ? graph.nodes.reduce((sum, n) => sum + (n.attempts?.fix ?? 0), 0)
    : 0;
  const retrySwitch = decisions.filter(
    (d) => d.decision === 'retry' || d.decision === 'switch_approach',
  ).length;
  return {
    work_item_id: summary.id,
    title: summary.title,
    status: summary.status,
    questions_asked: interview ? interview.exit.questions_asked : null,
    closure_mode: interview ? interview.exit.closure_mode : null,
    readiness_score: interview ? interview.readiness.score : null,
    readiness_gate: interview ? interview.readiness.gate : null,
    assumptions: interview ? interview.assumptions.length : 0,
    fix_nodes: fixNodes.length,
    rework_attempts: reworkAttempts,
    retry_switch_decisions: retrySwitch,
    handoff_rounds: handoffRounds,
  };
}

function totalsOf(rows: IntentQualityRow[]): IntentQualityTotals {
  return {
    work_items: rows.length,
    with_interview: rows.filter((r) => r.questions_asked !== null).length,
    total_questions: rows.reduce((s, r) => s + (r.questions_asked ?? 0), 0),
    total_fix_nodes: rows.reduce((s, r) => s + r.fix_nodes, 0),
    total_rework_attempts: rows.reduce((s, r) => s + r.rework_attempts, 0),
    total_retry_switch_decisions: rows.reduce((s, r) => s + r.retry_switch_decisions, 0),
    total_handoff_rounds: rows.reduce((s, r) => s + r.handoff_rounds, 0),
  };
}

export async function collectIntentQualityReport(
  deps: IntentQualityDeps,
): Promise<IntentQualityReport> {
  const summaries = await deps.listWorkItems();
  const rows: IntentQualityRow[] = [];
  for (const summary of summaries) {
    const [interview, graph, decisions, handoffRounds] = await Promise.all([
      deps.readInterview(summary.id),
      deps.readAutopilot(summary.id),
      deps.readDecisions(summary.id),
      deps.countHandoffRounds(summary.id),
    ]);
    rows.push(buildRow(summary, interview, graph, decisions, handoffRounds));
  }
  return { rows, totals: totalsOf(rows) };
}
