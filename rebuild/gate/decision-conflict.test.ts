import { describe, expect, test } from 'bun:test';

import {
  decisionConflictGate,
  routeDecisionConflict,
  type DecisionConflict,
} from './decision-conflict';

function conflict(overrides: Partial<DecisionConflict> = {}): DecisionConflict {
  return {
    adr: 'ADR-0001',
    kind: 'forbid',
    level: 'method',
    basis: 'ADR-0001이 제품 내 headless 모델 호출을 금지한다',
    ...overrides,
  };
}

describe('routeDecisionConflict — 결정론 라우팅 (kind × level × mode)', () => {
  test('prefer routes to justify regardless of level or mode', () => {
    for (const level of ['intent', 'method'] as const) {
      for (const mode of ['interactive', 'autopilot'] as const) {
        expect(
          routeDecisionConflict(conflict({ kind: 'prefer', level }), mode)
            .disposition,
        ).toBe('justify');
      }
    }
  });

  test('method-level forbid/require route to align (agent follows the ADR, no user round-trip)', () => {
    for (const kind of ['forbid', 'require'] as const) {
      expect(
        routeDecisionConflict(conflict({ kind, level: 'method' }), 'autopilot')
          .disposition,
      ).toBe('align');
    }
  });

  test('intent-level conflicts split by mode: interactive asks, autopilot blocks (fail-closed, no live wait)', () => {
    expect(
      routeDecisionConflict(conflict({ level: 'intent' }), 'interactive')
        .disposition,
    ).toBe('ask_user');
    expect(
      routeDecisionConflict(conflict({ level: 'intent' }), 'autopilot')
        .disposition,
    ).toBe('block');
  });

  test('transparency invariant: routing always carries the basis, and empty basis is refused', () => {
    const routed = routeDecisionConflict(conflict(), 'autopilot');
    expect(routed.basis).toContain('ADR-0001');
    expect(() =>
      routeDecisionConflict(conflict({ basis: '  ' }), 'autopilot'),
    ).toThrow(/basis/i);
  });
});

describe('decisionConflictGate — 완료 경로 집행', () => {
  test('no conflicts passes', () => {
    expect(decisionConflictGate([], 'autopilot').decision).toBe('pass');
  });

  test('method conflicts pass the gate but every disposition is disclosed with basis (no silent auto-compliance)', () => {
    const result = decisionConflictGate(
      [conflict({ kind: 'require', level: 'method' })],
      'autopilot',
    );
    expect(result.decision).toBe('pass');
    expect(result.routed).toHaveLength(1);
    expect(result.routed[0]?.disposition).toBe('align');
    expect(result.routed[0]?.basis.length).toBeGreaterThan(0);
  });

  test('an intent conflict blocks autonomous pass-close in both modes (only the user can lift it)', () => {
    for (const mode of ['interactive', 'autopilot'] as const) {
      const result = decisionConflictGate(
        [conflict({ level: 'intent' })],
        mode,
      );
      expect(result.decision).toBe('block');
    }
  });
});
