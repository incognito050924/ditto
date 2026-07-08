import { describe, expect, test } from 'bun:test';
import {
  type PrismRound,
  assignSeverity,
  closePrismNode,
  criticalTermination,
  detectDivergence,
  renderProgressSummary,
  resolveLaunchNotification,
  runPrismRounds,
  severityOf,
} from '~/core/prism/engine';
import { findUnexplainedIdentifiers } from '~/core/question-context';
import type { CoverageMap, CoverageNode } from '~/schemas/coverage';
import type { PrismIssueMap, PrismSeverityAssignment } from '~/schemas/prism';

// ── fixtures ─────────────────────────────────────────────────────────────────

function node(id: string, label: string, state: CoverageNode['state'] = 'open'): CoverageNode {
  return { id, parent_id: null, label, origin: 'seed', depth_weight: 0.5, state, children: [] };
}

function tree(nodes: CoverageNode[]): CoverageMap {
  return {
    schema_version: '0.1.0',
    work_item_id: 'wi_prismtest',
    root_id: 'prism_root0001',
    nodes,
  };
}

function prism(nodes: CoverageNode[], severities: PrismSeverityAssignment[] = []): PrismIssueMap {
  return {
    schema_version: '0.1.0',
    work_item_id: 'wi_prismtest',
    tree: tree(nodes),
    severities,
  };
}

const critical = (id: string): PrismSeverityAssignment => ({ node_id: id, severity: 'critical' });

// ── ac-2 · B1 vacuous-truth guard ────────────────────────────────────────────

describe('criticalTermination — B1 vacuous-truth guard (ac-2)', () => {
  test('a 0-critical map does NOT terminate (vacuous every([]) must not fire)', () => {
    // Two non-critical open nodes, ZERO critical assignments.
    const p = prism([
      node('prism_a0000001', '결제 실패 재시도'),
      node('prism_b0000002', '로그 포맷'),
    ]);
    const v = criticalTermination(p);
    // The trap: every() over an empty critical set is true. The guard must reject it.
    expect(v.terminated).toBe(false);
  });

  test('an empty map does NOT terminate', () => {
    expect(criticalTermination(prism([])).terminated).toBe(false);
  });

  test('all critical resolved → terminated (non-critical survivor does not block)', () => {
    const p = prism(
      [
        node('prism_c0000001', '인증 경계', 'resolved'),
        node('prism_d0000002', '로그 포맷', 'open'),
      ],
      [critical('prism_c0000001')],
    );
    expect(criticalTermination(p).terminated).toBe(true);
  });

  test('an unresolved critical node blocks termination', () => {
    const p = prism([node('prism_c0000001', '인증 경계', 'open')], [critical('prism_c0000001')]);
    expect(criticalTermination(p).terminated).toBe(false);
  });
});

// ── ac-2 · MODEL-1 unknown-close residual gate ───────────────────────────────

describe('closePrismNode — MODEL-1 unknown-close requires residual_risk (ac-2)', () => {
  test('a no-residual unknown-close of a CRITICAL node is REJECTED', () => {
    const p = prism([node('prism_c0000001', '인증 경계')], [critical('prism_c0000001')]);
    const r = closePrismNode(p, 'prism_c0000001', 'out_of_scope', '나중에');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('residual_risk');
  });

  test('an unknown-close WITH residual_risk is accepted and counts as critical resolution', () => {
    const p = prism([node('prism_c0000001', '인증 경계')], [critical('prism_c0000001')]);
    const r = closePrismNode(p, 'prism_c0000001', 'user_owned', '사용자 결정', '인증 미검증 잔여');
    expect(r.ok).toBe(true);
    // A residual-recorded unknown-close of the only critical node → termination fires.
    expect(criticalTermination(r.prism as PrismIssueMap).terminated).toBe(true);
  });

  test('a no-residual unknown-close of a NON-critical node is allowed', () => {
    const p = prism([node('prism_n0000001', '로그 포맷')]);
    expect(closePrismNode(p, 'prism_n0000001', 'out_of_scope', '범위 밖').ok).toBe(true);
  });
});

// ── ac-2 · MODEL-2 severity authority ────────────────────────────────────────

describe('assignSeverity — MODEL-2 severity authority gate', () => {
  test('critical→noncritical demotion without a reason is rejected', () => {
    const p = prism([node('prism_c0000001', '인증 경계')], [critical('prism_c0000001')]);
    const r = assignSeverity(p, 'prism_c0000001', 'noncritical');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('demotion');
  });

  test('demotion WITH a reason records the justification', () => {
    const p = prism([node('prism_c0000001', '인증 경계')], [critical('prism_c0000001')]);
    const r = assignSeverity(p, 'prism_c0000001', 'noncritical', '실측 결과 저위험으로 확인');
    expect(r.ok).toBe(true);
    expect(severityOf(r.prism as PrismIssueMap, 'prism_c0000001')).toBe('noncritical');
    const assign = (r.prism as PrismIssueMap).severities.find(
      (s) => s.node_id === 'prism_c0000001',
    );
    expect(assign?.demotion_reason).toBe('실측 결과 저위험으로 확인');
  });
});

// ── ac-3 · label-only progress summary ───────────────────────────────────────

describe('renderProgressSummary — label-only, no id/axis/schema leak (ac-3)', () => {
  test('renders only the open-node labels — no node id, state enum, severity, or axis name', () => {
    const p = prism(
      [
        node('prism_ab12cd34', '결제 실패 시 재시도 정책', 'open'),
        node('prism_ef56gh78', '이미 끝난 항목', 'resolved'),
      ],
      [critical('prism_ab12cd34')],
    );
    const summary = renderProgressSummary(p);
    expect(summary).toEqual(['결제 실패 시 재시도 정책']);
    const blob = summary.join('\n');
    expect(blob).toContain('결제 실패 시 재시도 정책');
    expect(blob).not.toContain('prism_ab12cd34');
    expect(blob).not.toContain('open');
    expect(blob).not.toContain('critical');
    expect(blob).not.toContain('completeness');
  });

  test('2nd defense: a prism node-id shape is caught by findUnexplainedIdentifiers', () => {
    // If a prism node id ever leaks into user-facing free text, the identifier
    // detector must catch it (question-context IDENTIFIER_PATTERNS).
    expect(findUnexplainedIdentifiers('남은 항목 prism_ab12cd34 확인')).toContain('prism_ab12cd34');
  });
});

// ── ac-4 · minimal-launch notification (one-shot + retract) ───────────────────

describe('resolveLaunchNotification — one-shot + retract on regression (ac-4)', () => {
  test('notifies once when critical resolved + non-critical survives, then is silent', () => {
    const p = prism(
      [
        node('prism_c0000001', '인증 경계', 'resolved'),
        node('prism_n0000002', '로그 포맷', 'open'),
      ],
      [critical('prism_c0000001')],
    );
    const first = resolveLaunchNotification(p, new Date('2026-07-07T00:00:00Z'));
    expect(first.notify).toBe(true);
    expect(first.prism.notified_at).toBeDefined();

    const second = resolveLaunchNotification(first.prism, new Date('2026-07-07T01:00:00Z'));
    expect(second.notify).toBe(false);
    expect(second.retracted).toBe(false);
  });

  test('a 0-critical map does not notify (B1 guard flows through)', () => {
    const p = prism([node('prism_n0000001', '로그 포맷', 'open')]);
    expect(resolveLaunchNotification(p, new Date()).notify).toBe(false);
  });

  test('regression (a new unresolved critical) retracts a prior notification', () => {
    const notified = prism(
      [node('prism_c0000001', '인증 경계', 'resolved')],
      [critical('prism_c0000001')],
    );
    const n1 = resolveLaunchNotification(notified, new Date('2026-07-07T00:00:00Z'));
    expect(n1.notify).toBe(true);
    // The map regresses: a fresh unresolved critical appears.
    const regressed: PrismIssueMap = {
      ...n1.prism,
      tree: tree([
        node('prism_c0000001', '인증 경계', 'resolved'),
        node('prism_e0000003', '새 위험', 'open'),
      ]),
      severities: [critical('prism_c0000001'), critical('prism_e0000003')],
    };
    const n2 = resolveLaunchNotification(regressed, new Date('2026-07-07T02:00:00Z'));
    expect(n2.retracted).toBe(true);
    expect(n2.prism.notified_at).toBeUndefined();
    // Re-reaching termination re-notifies.
    const rerecovered: PrismIssueMap = {
      ...n2.prism,
      tree: tree([
        node('prism_c0000001', '인증 경계', 'resolved'),
        node('prism_e0000003', '새 위험', 'resolved'),
      ]),
      severities: [critical('prism_c0000001'), critical('prism_e0000003')],
    };
    expect(resolveLaunchNotification(rerecovered, new Date('2026-07-07T03:00:00Z')).notify).toBe(
      true,
    );
  });
});

// ── ac-10 · divergence detection ─────────────────────────────────────────────

describe('detectDivergence — deterministic meaningless-divergence detection (ac-10)', () => {
  test('a near-duplicate question is flagged (repeat_question)', () => {
    const v = detectDivergence({ question: { signature: '재시도 횟수?', trivial: false } }, [
      { signature: '  재시도 횟수?  ', trivial: false },
    ]);
    expect(v.diverged).toBe(true);
    expect(v.kind).toBe('repeat_question');
    expect(v.action).toBe('cap-stop');
  });

  test('a streak of trivial questions is flagged (trivial_streak)', () => {
    const v = detectDivergence({ question: { signature: 'q3', trivial: true } }, [
      { signature: 'q1', trivial: true },
      { signature: 'q2', trivial: true },
    ]);
    expect(v.diverged).toBe(true);
    expect(v.kind).toBe('trivial_streak');
  });

  test('re-challenging a decided item with no new evidence is flagged, not silently dropped', () => {
    const v = detectDivergence(
      { challenge: { decided_id: 'prism_d0000001', signature: 'X 다시', new_evidence: false } },
      [],
    );
    expect(v.diverged).toBe(true);
    expect(v.kind).toBe('decided_conflict_no_evidence');
    expect(v.reason.length).toBeGreaterThan(0);
  });

  test('a challenge WITH new evidence is admitted as a visible challenge node (not divergence)', () => {
    const v = detectDivergence(
      { challenge: { decided_id: 'prism_d0000001', signature: 'X 다시', new_evidence: true } },
      [],
    );
    expect(v.diverged).toBe(false);
    expect(v.action).toBe('challenge-node');
  });
});

// ── ac-10 · cap really invoked in the loop ───────────────────────────────────

describe('runPrismRounds — cap is actually invoked and HALTS the loop (ac-10)', () => {
  test('the total-round cap stops the loop (cap ≠ termination ≠ success)', () => {
    const rounds: PrismRound[] = Array.from({ length: 10 }, (_, i) => ({
      question: { signature: `q${i}`, trivial: false },
    }));
    const result = runPrismRounds(rounds, { callsPerNode: 99, treeNodeCount: 999, totalRounds: 3 });
    expect(result.halted).toBe(true);
    expect(result.roundsRun).toBe(3);
    expect(result.escalation.join(' ')).toContain('round cap');
  });

  test('the tree-node cap stops the loop before running every round', () => {
    const rounds: PrismRound[] = Array.from({ length: 10 }, () => ({ addedNodeCount: 5 }));
    const result = runPrismRounds(rounds, { callsPerNode: 99, treeNodeCount: 12, totalRounds: 99 });
    expect(result.halted).toBe(true);
    expect(result.treeNodeCount).toBeLessThanOrEqual(12 + 5);
    expect(result.escalation.join(' ')).toContain('tree node-count cap');
  });

  test('under the caps the loop runs every round and does not halt', () => {
    const rounds: PrismRound[] = Array.from({ length: 4 }, (_, i) => ({
      question: { signature: `q${i}`, trivial: false },
    }));
    const result = runPrismRounds(rounds, {
      callsPerNode: 99,
      treeNodeCount: 999,
      totalRounds: 99,
    });
    expect(result.halted).toBe(false);
    expect(result.roundsRun).toBe(4);
  });
});
