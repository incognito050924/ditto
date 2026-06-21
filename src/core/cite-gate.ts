import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';
import type { MeasurementReport } from './memory-measure';
import { readUsageReport } from './memory-warmstart';

/**
 * 완료측 cite-or-abstain advisory gate (memory-librarian §8 inc.2, ac-2).
 *
 * The push side is done: `CITE_OR_ABSTAIN_DIRECTIVE` is injected whenever a
 * node's packet carries `context.memory.decision_briefs`. But nothing read the
 * agent's cite/abstain back, so an injected decision could be silently ignored.
 * This gate closes that loop on the completion path — it is ADVISORY: a pushed
 * node whose output neither cites nor abstains earns a WARNING, never a hard
 * block (the intent chose advisory + 완료게이트 연동, not 강제 차단).
 *
 * Denominator (the Opponent's non-negotiable): "push된 work item" = the nodes
 * that actually received a decision-lineage push. The deterministic, queryable
 * source of truth is `warmstart-usage.jsonl` `actionable: true` records — a
 * non-empty memory context (≥1 decision brief) was injected into that node's
 * packet (see memory-warmstart `base.actionable`). No actionable record ⇒ empty
 * denominator ⇒ verdict `skip` (info), NOT a vacuous "checked & passed".
 */

export interface CiteWarning {
  node_id: string;
  message: string;
}

export interface CiteGateResult {
  /**
   * `skip` = empty denominator (no node received a lineage push) → nothing to
   * check, recorded as info (must NOT be read as a checked pass — vacuous-coverage
   * guard). `pass` = every pushed node cited or abstained. `warning` = ≥1 pushed
   * node neither cited nor abstained (advisory; the completion path stays open).
   */
  verdict: 'skip' | 'pass' | 'warning';
  /** the node ids that received a decision-lineage push (the real denominator). */
  pushed_node_ids: string[];
  warnings: CiteWarning[];
}

/** A node's persisted output cited a governing decision (decision:<id> or ADR-NNNN). */
const CITE_RE = /\bdecision:|\bADR-\d/i;
/** A node's persisted output explicitly abstained (cite-or-abstain: none apply). */
const ABSTAIN_RE =
  /\babstain|none\s+(?:of\s+the\s+)?(?:governing\s+)?decisions?\s+apply|none\s+apply/i;

/** The cite/abstain signal lives in the node's persisted evidence text. */
function evidenceText(node: AutopilotNode): string {
  return node.evidence_refs
    .map((e) => [e.summary, e.command, e.path].filter(Boolean).join(' '))
    .join(' ');
}

function citedOrAbstained(node: AutopilotNode): boolean {
  const text = evidenceText(node);
  return CITE_RE.test(text) || ABSTAIN_RE.test(text);
}

export interface CiteGateInput {
  workItemId: string;
  graph: Autopilot;
}

export async function checkCiteGate(
  repoRoot: string,
  input: CiteGateInput,
): Promise<CiteGateResult> {
  // Denominator: nodes that actually received a decision-lineage push.
  const report = await readUsageReport(repoRoot, input.workItemId);
  const pushedNodeIds = [
    ...new Set(report.records.filter((r) => r.actionable).map((r) => r.node_id)),
  ].sort();

  // Zero-denominator ⇒ skip/info, never a vacuous checked-pass.
  if (pushedNodeIds.length === 0) {
    return { verdict: 'skip', pushed_node_ids: [], warnings: [] };
  }

  const byId = new Map(input.graph.nodes.map((n) => [n.id, n]));
  const warnings: CiteWarning[] = [];
  for (const id of pushedNodeIds) {
    const node = byId.get(id);
    // A pushed node that vanished from the graph can't have its output checked —
    // not a clean cite, so surface it as a warning (advisory, never a block).
    if (!node || !citedOrAbstained(node)) {
      warnings.push({
        node_id: id,
        message: `노드 ${id}는 거버닝 결정 push를 받았으나 출력이 결정을 인용(cite)하지도 명시적으로 기권(abstain)하지도 않았다 — 결정 무시 가능성(advisory, ac-2)`,
      });
    }
  }

  return {
    verdict: warnings.length > 0 ? 'warning' : 'pass',
    pushed_node_ids: pushedNodeIds,
    warnings,
  };
}

/**
 * Cross-validate the cite signal against the hallucination-reduction outcome
 * (memory-librarian §8 inc.5, ac-4 · ADR-0013 D4 measure-before-expand).
 *
 * 표식 단독 성공 판정 금지: a cite-gate `pass` only means pushed nodes formally
 * cited/abstained — it does NOT prove the decision was actually consulted. The
 * pre-mortem risk is a high cite rate with an unchanged re-proposal rate (hollow
 * cite). So the cite signal is "confirmed" only when the deterministic re-proposal
 * rate (memory-measure) is at/below a known baseline; otherwise the cite is
 * surfaced as cited-but-unvalidated, and with no baseline it is cannot-confirm.
 * ADVISORY only — consistent with the non-blocking cite-gate.
 */
export interface CiteCrossCheck {
  /**
   * `confirmed` = cite-gate pass AND re-proposal rate ≤ baseline (outcome backs the
   * cite). `cited-but-unvalidated` = cite-gate pass but re-proposal rate did NOT
   * improve (cite alone ≠ success). `cannot-confirm` = cite-gate pass but no
   * baseline to compare against. `not-applicable` = cite-gate did not pass (skip /
   * warning) — there is no clean cite to validate.
   */
  combined: 'confirmed' | 'cited-but-unvalidated' | 'cannot-confirm' | 'not-applicable';
  cite_verdict: CiteGateResult['verdict'];
  reproposal_rate: number;
  baseline_reproposal_rate?: number;
  /** This check never blocks the completion path (mirrors the cite-gate). */
  advisory: true;
}

export interface CiteCrossCheckOptions {
  /** Prior re-proposal rate to compare against; absent ⇒ cannot-confirm. */
  baseline_reproposal_rate?: number;
}

export function crossValidateCite(
  cite: CiteGateResult,
  measurement: MeasurementReport,
  options: CiteCrossCheckOptions = {},
): CiteCrossCheck {
  const rate = measurement.reproposal_rate;
  const baseline = options.baseline_reproposal_rate;

  let combined: CiteCrossCheck['combined'];
  if (cite.verdict !== 'pass') {
    // No clean cite to validate — skip/warning is not a success to begin with.
    combined = 'not-applicable';
  } else if (baseline === undefined) {
    // Cite alone ≠ success: with no baseline the outcome cannot back the cite.
    combined = 'cannot-confirm';
  } else if (rate <= baseline) {
    combined = 'confirmed';
  } else {
    combined = 'cited-but-unvalidated';
  }

  return {
    combined,
    cite_verdict: cite.verdict,
    reproposal_rate: rate,
    ...(baseline !== undefined ? { baseline_reproposal_rate: baseline } : {}),
    advisory: true,
  };
}
