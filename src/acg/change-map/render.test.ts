import { describe, expect, test } from 'bun:test';
import type { AcgChangeContract } from '~/schemas/acg-change-contract';
import type { AcgImpactGraph } from '~/schemas/acg-impact-graph';
import type { AcgReviewGraph } from '~/schemas/acg-review-graph';
import { render } from './render';

// 50-change-map §2.1 텍스트 정본 렌더러. 라인 형식·enum 토큰·ReviewGraph 폴백을 검증한다.

const contract = (overrides: Partial<AcgChangeContract> = {}): AcgChangeContract => ({
  schema_version: '0.1.0',
  kind: 'acg.change-contract.v1',
  work_item_id: 'wi_abcd1234',
  produced_by: 'agent',
  produced_at: '2026-06-04T00:00:00Z',
  purpose: '재시도를 지수 백오프로',
  allowed_scope: [{ kind: 'glob', ref: 'src/runtime/**' }],
  forbidden_scope: [
    { kind: 'path', ref: 'src/kafka-adapter.ts' },
    { kind: 'symbol', ref: 'TenantContext' },
  ],
  invariants: [],
  acceptance: [{ criterion: '재시도 간격 1s,2s,4s', evidence_kind: 'test' }],
  decision_ref: null,
  risk_default: 'medium',
  ...overrides,
});

const impact = (): AcgImpactGraph => ({
  schema_version: '0.1.0',
  kind: 'acg.impact-graph.v1',
  work_item_id: 'wi_abcd1234',
  produced_by: 'agent',
  produced_at: '2026-06-04T00:00:00Z',
  change_target: 'src/runtime/retry.ts: RetryPolicy (signature)',
  change_type: 'signature',
  affected_nodes: [
    { kind: 'direct_caller', path: 'src/runtime/RetryHandler.ts', handled: true },
    { kind: 'test', path: 'src/runtime/RetryPolicy.test.ts', handled: false },
  ],
  unresolved: [{ kind: 'config_driven', path: 'retry 설정', reason: '런타임 프로퍼티 확인 필요' }],
});

describe('change-map render (§2.1)', () => {
  test('decision_ref가 있으면 risk_default(medium) 폴백 + §2.1 라인 형식', () => {
    const out = render(contract({ decision_ref: 'ADR-0007' }));
    const lines = out.split('\n');

    // ◆ <id> <risk_badge> "<purpose>" — ReviewGraph 없을 때 risk_default 폴백.
    expect(lines[0]).toBe('◆ wi_abcd1234 🟡[medium] "재시도를 지수 백오프로"');
    expect(lines[1]).toBe('  decision: ADR-0007');
    expect(lines[2]).toBe('  scope:');
    expect(lines[3]).toBe('    allow ─ src/runtime/**');
    expect(lines[4]).toBe('    forbid ✕ src/kafka-adapter.ts  ✕ TenantContext');
    // ReviewGraph 없으면 accept 뱃지는 ☐.
    expect(out).toContain('    ☐ "재시도 간격 1s,2s,4s" (test)');
  });

  test('decision_ref가 없으면 — 로 표기, risk_default(low) 폴백', () => {
    const out = render(contract({ decision_ref: null, risk_default: 'low' }));
    const lines = out.split('\n');
    expect(lines[0]).toBe('◆ wi_abcd1234 🟢[low] "재시도를 지수 백오프로"');
    expect(lines[1]).toBe('  decision: —');
  });

  test('ImpactGraph가 있으면 → impact edge + ⚠ unresolved enum 토큰 렌더', () => {
    const out = render(contract({ decision_ref: 'ADR-0007' }), impact());
    expect(out).toContain('  impact:');
    // impact_kind enum 토큰 그대로, ReviewGraph 없으면 증거뱃지 ☐.
    expect(out).toContain('    → direct_caller src/runtime/RetryHandler.ts ☐');
    expect(out).toContain('    → test src/runtime/RetryPolicy.test.ts ☐');
    // unresolved_kind enum 토큰.
    expect(out).toContain('    ⚠ unresolved: config_driven retry 설정 — 런타임 프로퍼티 확인 필요');
  });

  test('ReviewGraph가 있으면 최고위험으로 risk_badge, evidence/unresolved로 증거뱃지', () => {
    const review: AcgReviewGraph = {
      kind: 'acg.review-graph.v1',
      files: [
        {
          path: 'src/runtime/RetryHandler.ts',
          role: 'service_logic',
          risk: 'high',
          risk_reason: 'public behavior 변경',
          evidence: { kind: 'test' },
          unresolved: false,
        },
        {
          path: 'src/runtime/RetryPolicy.test.ts',
          role: 'test_fixture',
          risk: 'low',
          risk_reason: 'fixture',
          unresolved: true,
        },
      ],
      human_review_set: ['src/runtime/RetryHandler.ts'],
    };
    const out = render(contract({ decision_ref: 'ADR-0007' }), impact(), review);
    const lines = out.split('\n');
    // 최고위험 high → 🔴[high] (risk_default medium 무시).
    expect(lines[0]).toBe('◆ wi_abcd1234 🔴[high] "재시도를 지수 백오프로"');
    // evidence 있음 → ☑, unresolved → ⚠.
    expect(out).toContain('    → direct_caller src/runtime/RetryHandler.ts ☑');
    expect(out).toContain('    → test src/runtime/RetryPolicy.test.ts ⚠');
  });
});
