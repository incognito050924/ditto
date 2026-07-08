import { describe, expect, test } from 'bun:test';
import {
  type PrismRound,
  assignSeverity,
  buildIntentFragments,
  closePrismNode,
  completenessSeedId,
  criticalTermination,
  deriveFragmentMappings,
  detectDivergence,
  renderProgressSummary,
  resolveLaunchNotification,
  runPrismRounds,
  seedUncoveredFragments,
  severityOf,
} from '~/core/prism/engine';
import { findUnexplainedIdentifiers } from '~/core/question-context';
import type { CoverageMap, CoverageNode } from '~/schemas/coverage';
import type { PrismIssueMap, PrismNodeEvaluation, PrismSeverityAssignment } from '~/schemas/prism';

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

function prism(
  nodes: CoverageNode[],
  severities: PrismSeverityAssignment[] = [],
  evaluations: PrismNodeEvaluation[] = [],
): PrismIssueMap {
  return {
    schema_version: '0.1.0',
    work_item_id: 'wi_prismtest',
    tree: tree(nodes),
    severities,
    evaluations,
  };
}

const critical = (id: string): PrismSeverityAssignment => ({ node_id: id, severity: 'critical' });

const evalRec = (
  nodeId: string,
  patch: Partial<Omit<PrismNodeEvaluation, 'node_id'>>,
): PrismNodeEvaluation => ({ node_id: nodeId, ...patch });

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

// ── ac-1 · A2 critical resolved-close gate + gate↔score self-check ───────────

describe('closePrismNode — A2 critical resolved-close gate (ac-1)', () => {
  test('a critical resolved-close with no justifying_reason is REJECTED and stamped unevaluated', () => {
    const p = prism([node('prism_c0000001', '인증 경계')], [critical('prism_c0000001')]);
    const r = closePrismNode(p, 'prism_c0000001', 'resolved');
    expect(r.ok).toBe(false);
    const ev = (r.prism as PrismIssueMap).evaluations.find((e) => e.node_id === 'prism_c0000001');
    expect(ev?.evaluation).toBe('unevaluated');
  });

  test('OBJ-1 trivial-proxy floor: reason + refutation but NO added evidence is still REJECTED', () => {
    // justifying_reason + refutation_attempted present, but the node has no child
    // decomposition and no recorded opponent artifact → evidence-added == 0.
    const p = prism(
      [node('prism_c0000001', '인증 경계')],
      [critical('prism_c0000001')],
      [evalRec('prism_c0000001', { justifying_reason: '검토함', refutation_attempted: true })],
    );
    const r = closePrismNode(p, 'prism_c0000001', 'resolved');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('grounding');
    const ev = (r.prism as PrismIssueMap).evaluations.find((e) => e.node_id === 'prism_c0000001');
    expect(ev?.evaluation).toBe('unevaluated');
  });

  test('reason + refutation + a child decomposition passes and is stamped justified', () => {
    // parent has a (closed) child → evidence-added > 0 (decomposition grounding).
    const parent = { ...node('prism_c0000001', '인증 경계'), children: ['prism_ch000002'] };
    const child = {
      ...node('prism_ch000002', '토큰 검증', 'resolved'),
      parent_id: 'prism_c0000001',
    };
    const p = prism(
      [parent, child],
      [critical('prism_c0000001')],
      [
        evalRec('prism_c0000001', {
          justifying_reason: '토큰 검증 완료',
          refutation_attempted: true,
        }),
      ],
    );
    const r = closePrismNode(p, 'prism_c0000001', 'resolved');
    expect(r.ok).toBe(true);
    const ev = (r.prism as PrismIssueMap).evaluations.find((e) => e.node_id === 'prism_c0000001');
    expect(ev?.evaluation).toBe('justified');
  });

  test('a recorded opponent critique counts as added evidence', () => {
    const p = prism(
      [node('prism_c0000001', '인증 경계')],
      [critical('prism_c0000001')],
      [
        evalRec('prism_c0000001', {
          justifying_reason: '반박 검토 완료',
          refutation_attempted: true,
          opponent_critique: 'DA: 세션 고정 미검토 → 반박: scope 밖으로 확인',
        }),
      ],
    );
    expect(closePrismNode(p, 'prism_c0000001', 'resolved').ok).toBe(true);
  });

  test('the A2 gate applies to critical ONLY — a noncritical resolved-close needs no justification', () => {
    const p = prism([node('prism_n0000001', '로그 포맷')]);
    expect(closePrismNode(p, 'prism_n0000001', 'resolved').ok).toBe(true);
  });
});

describe('criticalTermination — gate↔score: unevaluated critical does NOT count (ac-1)', () => {
  test('a critical node resolved-in-state but unevaluated-in-annotation does NOT count as resolved', () => {
    const p = prism(
      [node('prism_c0000001', '인증 경계', 'resolved')],
      [critical('prism_c0000001')],
      [evalRec('prism_c0000001', { evaluation: 'unevaluated' })],
    );
    expect(criticalTermination(p).terminated).toBe(false);
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

// ── ac-2 · completeness-termination seed ─────────────────────────────────────

describe('seedUncoveredFragments — original-intent completeness seed (ac-2)', () => {
  const fragments = [
    { id: 'goal', text: '결제 안정화' },
    { id: 'in_scope[0]', text: '재시도 정책' },
  ];

  test('a fragment with zero addressing node is seeded as an open node (gap surfaced)', () => {
    const p = prism([node('prism_a0000001', '결제 안정화 작업')]);
    // only 'goal' is explicitly mapped; 'in_scope[0]' has no addressing node.
    const r = seedUncoveredFragments(p, fragments, [
      { fragment_id: 'goal', node_id: 'prism_a0000001' },
    ]);
    expect(r.seededFragmentIds).toEqual(['in_scope[0]']);
    const seeded = r.prism.tree.nodes.find((n) => n.label === '재시도 정책');
    expect(seeded?.state).toBe('open');
    // surfaced in the label-only progress summary (the user sees the gap)
    expect(renderProgressSummary(r.prism)).toContain('재시도 정책');
  });

  test('a fully-mapped intent seeds nothing (explicit-mapping-absence only)', () => {
    const p = prism([node('prism_a0000001', 'g'), node('prism_b0000002', 's')]);
    const r = seedUncoveredFragments(p, fragments, [
      { fragment_id: 'goal', node_id: 'prism_a0000001' },
      { fragment_id: 'in_scope[0]', node_id: 'prism_b0000002' },
    ]);
    expect(r.seededFragmentIds).toEqual([]);
  });

  test('a mapping to a NON-existent node does not count as coverage → still seeds', () => {
    const p = prism([node('prism_a0000001', 'g')]);
    const r = seedUncoveredFragments(p, fragments, [
      { fragment_id: 'goal', node_id: 'prism_a0000001' },
      { fragment_id: 'in_scope[0]', node_id: 'ghost_node_00' },
    ]);
    expect(r.seededFragmentIds).toEqual(['in_scope[0]']);
  });

  test('idempotent — re-seeding the same gap does not duplicate', () => {
    const p = prism([node('prism_a0000001', 'g')]);
    const once = seedUncoveredFragments(p, fragments, [
      { fragment_id: 'goal', node_id: 'prism_a0000001' },
    ]);
    const twice = seedUncoveredFragments(once.prism, fragments, [
      { fragment_id: 'goal', node_id: 'prism_a0000001' },
    ]);
    expect(twice.seededFragmentIds).toEqual([]);
    const seedCount = twice.prism.tree.nodes.filter((n) => n.label === '재시도 정책').length;
    expect(seedCount).toBe(1);
  });

  test('the seed is NONCRITICAL — it surfaces the gap but cannot flip termination off (no unterminatable loop)', () => {
    // all critical scope resolved → termination fires.
    const p = prism([node('prism_c0000001', '인증', 'resolved')], [critical('prism_c0000001')]);
    expect(criticalTermination(p).terminated).toBe(true);
    // seeding uncovered fragments must NOT convert termination → non-termination.
    const r = seedUncoveredFragments(p, fragments, []);
    expect(r.seededFragmentIds.length).toBeGreaterThan(0);
    expect(severityOf(r.prism, completenessSeedId('goal'))).toBe('noncritical');
    expect(criticalTermination(r.prism).terminated).toBe(true);
  });

  test('seeds attach under the root when it exists (append-only, no dangling)', () => {
    const rootNode = { ...node('prism_root0001', '원 의도'), children: [] as string[] };
    const p = prism([rootNode]);
    const r = seedUncoveredFragments(p, fragments, []);
    expect(r.seededFragmentIds).toEqual(['goal', 'in_scope[0]']);
    const seeded = r.prism.tree.nodes.find((n) => n.id === completenessSeedId('goal'));
    expect(seeded?.parent_id).toBe('prism_root0001');
  });
});

describe('buildIntentFragments — deterministic intent split (ac-2)', () => {
  test('goal + each in_scope item become stable-id fragments; blank entries dropped (index preserved)', () => {
    const frags = buildIntentFragments({
      goal: '결제 안정화',
      in_scope: ['재시도 정책', '  ', '알림 채널'],
    });
    expect(frags).toEqual([
      { id: 'goal', text: '결제 안정화' },
      { id: 'in_scope[0]', text: '재시도 정책' },
      { id: 'in_scope[2]', text: '알림 채널' },
    ]);
  });

  test('a missing goal / empty in_scope yields no fragment', () => {
    expect(buildIntentFragments({ in_scope: [] })).toEqual([]);
    expect(buildIntentFragments({ goal: '   ' })).toEqual([]);
  });
});

describe('deriveFragmentMappings — string-level explicit mapping (ac-2)', () => {
  const frags = [
    { id: 'goal', text: '결제 재시도 정책' },
    { id: 'in_scope[0]', text: '배송 추적 알림' },
  ];

  test('a fragment whose keyword appears in a node label maps to it; a fragment no node references stays unmapped', () => {
    const p = prism([node('prism_a0000001', '결제 재시도 정책 로직')]);
    const m = deriveFragmentMappings(frags, p);
    expect(m).toContainEqual({ fragment_id: 'goal', node_id: 'prism_a0000001' });
    // '배송 추적 알림' has no addressing node → it is NOT mapped (so it would be seeded).
    expect(m.some((x) => x.fragment_id === 'in_scope[0]')).toBe(false);
  });

  test('close_reason text also counts as addressing a fragment', () => {
    const n = {
      ...node('prism_b0000002', '무관 라벨', 'resolved'),
      close_reason: '배송 추적 알림 처리 완료',
    };
    const p = prism([n]);
    const m = deriveFragmentMappings(frags, p);
    expect(m).toContainEqual({ fragment_id: 'in_scope[0]', node_id: 'prism_b0000002' });
  });

  test('the derived mappings drive seedUncoveredFragments: only the uncovered fragment is seeded', () => {
    const p = prism([node('prism_a0000001', '결제 재시도 정책 로직')]);
    const r = seedUncoveredFragments(p, frags, deriveFragmentMappings(frags, p));
    expect(r.seededFragmentIds).toEqual(['in_scope[0]']);
  });
});

// ── follow-up #1 (wi_260708jnp): token set-membership, not substring includes ──
// The prior impl matched via `node.text.includes(kw)`, so a keyword that is only a
// word-INTERNAL substring of an unrelated node token produced a false mapping (the
// fragment looked "covered" and was never seeded as a gap). The fix tokenizes the
// node text with the SAME splitter and tests set membership.
describe('deriveFragmentMappings — token match, no word-internal false-coverage (wi_260708jnp)', () => {
  test('a keyword that is only a substring INSIDE an unrelated node token does NOT map', () => {
    // keyword 'id' is a substring of 'provider' but NOT a standalone token of the node.
    const frags = [{ id: 'goal', text: 'id 매핑 취소' }];
    const p = prism([node('prism_x0000001', 'provider 라우팅 계층')]);
    const m = deriveFragmentMappings(frags, p);
    // 'id' must not match 'provider'; '매핑'/'취소' are absent → no mapping at all.
    expect(m).toEqual([]);
  });

  test('an exact whole-token match still maps (no regression)', () => {
    const frags = [{ id: 'goal', text: 'id 매핑 취소' }];
    // node carries 'id' as a standalone token → legitimate coverage.
    const p = prism([node('prism_x0000002', 'id 매핑 로직')]);
    const m = deriveFragmentMappings(frags, p);
    expect(m).toContainEqual({ fragment_id: 'goal', node_id: 'prism_x0000002' });
  });

  test('close_reason tokens also count (whole-token), still no substring bleed', () => {
    const frags = [{ id: 'goal', text: '결제 취소' }];
    const covered = {
      ...node('prism_x0000003', '무관', 'resolved'),
      close_reason: '결제 취소 처리',
    };
    const bleed = node('prism_x0000004', '취소불가정책'); // '취소' is a substring, not a token
    const p = prism([covered, bleed]);
    const m = deriveFragmentMappings(frags, p);
    expect(m).toContainEqual({ fragment_id: 'goal', node_id: 'prism_x0000003' });
    expect(m.some((x) => x.node_id === 'prism_x0000004')).toBe(false);
  });

  test('no token match anywhere → empty mappings', () => {
    const frags = [{ id: 'goal', text: '완전히 무관한 조각' }];
    const p = prism([node('prism_x0000005', 'provider 라우팅')]);
    expect(deriveFragmentMappings(frags, p)).toEqual([]);
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

// ── ac-3 · launch re-anchor surface (achieve vs characterize, non-blocking) ──

describe('resolveLaunchNotification — original-intent re-anchor surface (ac-3)', () => {
  const terminatedMap = () =>
    prism([node('prism_c0000001', '인증', 'resolved')], [critical('prism_c0000001')]);

  test('when launch fires, the notification surfaces the original intent + an achieve-vs-characterize prompt', () => {
    const r = resolveLaunchNotification(
      terminatedMap(),
      new Date('2026-07-08T00:00:00Z'),
      '결제 재시도 정책을 안정화한다',
    );
    expect(r.notify).toBe(true);
    expect(r.reAnchor).toBeDefined();
    expect(r.reAnchor as string).toContain('결제 재시도 정책을 안정화한다');
    // the re-facing prompt distinguishes 달성(achieve) vs 특징 서술(characterize)
    expect(r.reAnchor as string).toContain('특징');
    // NON-BLOCKING: the surface does not change launch/retraction flow
    expect(r.retracted).toBe(false);
  });

  test('backward-compatible: no original intent → no reAnchor, launch unchanged', () => {
    const r = resolveLaunchNotification(terminatedMap(), new Date('2026-07-08T00:00:00Z'));
    expect(r.notify).toBe(true);
    expect(r.reAnchor).toBeUndefined();
  });

  test('re-anchor rides the one-shot notify only, not the silent second read', () => {
    const first = resolveLaunchNotification(
      terminatedMap(),
      new Date('2026-07-08T00:00:00Z'),
      '원 의도',
    );
    expect(first.reAnchor).toBeDefined();
    const second = resolveLaunchNotification(
      first.prism,
      new Date('2026-07-08T01:00:00Z'),
      '원 의도',
    );
    expect(second.notify).toBe(false);
    expect(second.reAnchor).toBeUndefined();
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
