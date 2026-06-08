import type { Autopilot } from '~/schemas/autopilot';
import type { ClosureMode } from '~/schemas/convergence';
import type { IntentMetric } from '~/schemas/intent-metric';
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
 * process metric (questions_asked) sitting next to the outcome metric (drift +
 * rework). The drift signal comes from metrics.jsonl, which the Stop hook (P3)
 * persists; `post_cost` folds drift and rework into one cost, and the
 * correlation table buckets work items by questions-asked quantile (D4).
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
  /** Persisted intent-drift events (metrics.jsonl) — the post-hoc outcome cost. */
  drift_events: number;
  /** Combined post-intent cost: drift + rework + retries + handoffs. */
  post_cost: number;
}

export interface IntentQualityTotals {
  work_items: number;
  with_interview: number;
  total_questions: number;
  total_fix_nodes: number;
  total_rework_attempts: number;
  total_retry_switch_decisions: number;
  total_handoff_rounds: number;
  total_drift_events: number;
}

/** One questions-asked quantile bucket with its mean post-intent cost (D4). */
export interface CorrelationBucket {
  quantile: 'low' | 'mid' | 'high';
  work_items: number;
  /** [min, max] questions_asked in the bucket; null when empty. */
  questions_range: [number, number] | null;
  avg_questions: number;
  avg_post_cost: number;
}

export interface IntentQualityReport {
  rows: IntentQualityRow[];
  totals: IntentQualityTotals;
  /** Questions-quantile × post-cost correlation over interviewed work items (D4). */
  correlation: CorrelationBucket[];
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
  /** Read persisted intent-metric drift events (metrics.jsonl; empty when absent). */
  readMetrics(workItemId: string): Promise<IntentMetric[]>;
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
    readMetrics: (id) => workItems.readMetrics(id),
  };
}

function buildRow(
  summary: WorkItemSummary,
  interview: InterviewState | null,
  graph: Autopilot | null,
  decisions: AutopilotDecision[],
  handoffRounds: number,
  driftEvents: number,
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
    drift_events: driftEvents,
    post_cost: driftEvents + reworkAttempts + retrySwitch + handoffRounds,
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
    total_drift_events: rows.reduce((s, r) => s + r.drift_events, 0),
  };
}

const QUANTILES = ['low', 'mid', 'high'] as const;

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * D4 core: bucket the interviewed work items (those with a questions_asked
 * value) by questions-asked tercile and report the mean post-cost per bucket.
 * Items are sorted by questions then split into three contiguous, near-equal
 * groups; the answer to "are few questions thrift or neglect?" is whether the
 * low-questions bucket carries a higher avg_post_cost than the high bucket.
 * Always emits three buckets so the shape is stable even at small N (empty
 * buckets carry zeros) — meaningful only once samples accumulate.
 */
function correlationOf(rows: IntentQualityRow[]): CorrelationBucket[] {
  const interviewed = rows
    .filter((r): r is IntentQualityRow & { questions_asked: number } => r.questions_asked !== null)
    .sort((a, b) => a.questions_asked - b.questions_asked);
  const n = interviewed.length;
  return QUANTILES.map((quantile, b) => {
    const slice =
      n === 0 ? [] : interviewed.filter((_, idx) => Math.min(2, Math.floor((idx * 3) / n)) === b);
    const questions = slice.map((r) => r.questions_asked);
    return {
      quantile,
      work_items: slice.length,
      questions_range:
        questions.length === 0 ? null : [Math.min(...questions), Math.max(...questions)],
      avg_questions: mean(questions),
      avg_post_cost: mean(slice.map((r) => r.post_cost)),
    };
  });
}

export async function collectIntentQualityReport(
  deps: IntentQualityDeps,
): Promise<IntentQualityReport> {
  const summaries = await deps.listWorkItems();
  const rows: IntentQualityRow[] = [];
  for (const summary of summaries) {
    const [interview, graph, decisions, handoffRounds, metrics] = await Promise.all([
      deps.readInterview(summary.id),
      deps.readAutopilot(summary.id),
      deps.readDecisions(summary.id),
      deps.countHandoffRounds(summary.id),
      deps.readMetrics(summary.id),
    ]);
    rows.push(buildRow(summary, interview, graph, decisions, handoffRounds, metrics.length));
  }
  return { rows, totals: totalsOf(rows), correlation: correlationOf(rows) };
}
