import { describe, expect, test } from 'bun:test';
import {
  extractInvariants,
  extractRejectedAlternatives,
  measureHallucination,
} from '~/core/memory-measure';

const ADR_WITH_SECTION = `# ADR-0099: A decision

- 관련: src/core/x.ts

## 결정
use the thing.

## 대안 (기각)

- **Embedding/vector matching**: 비결정·비쌈. 기각.
- **별도 그래프 DB(Neo4j)**: 무서버 위반. 기각.

## 철회 조건
- never.
`;

const ADR_NO_SECTION = `# ADR-0002: schema SoT

## 결정
schema is the source of truth.

## 근거
single source.
`;

const ADR_WITH_INVARIANT = `# ADR-0011: distribution

## 결정
- session-rooting invariant: 트리 밖 재배치 금지.
- 이 결정은 불변식이다.

## 대안 (기각)
- **cross-repo subagent 위임**: 비범위. 기각.
`;

describe('extractRejectedAlternatives (§8 inc.5 — denominator parser)', () => {
  test('parses bullet items under a 대안 (기각) heading', () => {
    const items = extractRejectedAlternatives(ADR_WITH_SECTION);
    expect(items.length).toBe(2);
    expect(items[0]).toContain('Embedding/vector matching');
    expect(items[1]).toContain('Neo4j');
  });

  test('stops at the next heading (does not bleed into 철회 조건)', () => {
    const items = extractRejectedAlternatives(ADR_WITH_SECTION);
    expect(items.join(' ')).not.toContain('never');
  });

  test('returns [] for an ADR with no rejected-alternatives section', () => {
    expect(extractRejectedAlternatives(ADR_NO_SECTION)).toEqual([]);
  });

  test('matches the 대안과 폐기 사유 heading variant', () => {
    const variant = ADR_WITH_SECTION.replace('## 대안 (기각)', '## 대안과 폐기 사유');
    expect(extractRejectedAlternatives(variant).length).toBe(2);
  });
});

describe('extractInvariants (§8 inc.5 — low-precision keyword scan)', () => {
  test('captures lines mentioning 불변식/invariant', () => {
    const inv = extractInvariants(ADR_WITH_INVARIANT);
    expect(inv.length).toBeGreaterThanOrEqual(2);
    expect(inv.some((l) => l.includes('session-rooting invariant'))).toBe(true);
  });

  test('returns [] when no invariant keyword present', () => {
    expect(extractInvariants(ADR_NO_SECTION)).toEqual([]);
  });
});

describe('measureHallucination (§8 inc.5, ac-5 — baseline + rate path)', () => {
  const adrs = [
    { id: 'ADR-0099', body: ADR_WITH_SECTION },
    { id: 'ADR-0002', body: ADR_NO_SECTION },
    { id: 'ADR-0011', body: ADR_WITH_INVARIANT },
  ];

  test('baseline inventory: counts items, invariants, and ADR coverage', () => {
    const r = measureHallucination(adrs, []);
    expect(r.rejected_alternatives_total).toBe(3); // 2 + 0 + 1
    expect(r.adrs_total).toBe(3);
    expect(r.adrs_with_rejected_section).toBe(2); // 0099, 0011
    expect(r.adrs_without_rejected_section).toEqual(['ADR-0002']);
    expect(r.invariants_total).toBeGreaterThanOrEqual(2);
    // baseline (no candidate texts) → nothing re-proposed
    expect(r.reproposals_detected).toBe(0);
    expect(r.reproposal_rate).toBe(0);
  });

  test('detects a re-proposal when a candidate text echoes a rejected alternative', () => {
    const candidate = 'plan: we should adopt Neo4j as the graph store for speed.';
    const r = measureHallucination(adrs, [candidate]);
    expect(r.reproposals_detected).toBeGreaterThanOrEqual(1);
    expect(r.reproposal_rate).toBeGreaterThan(0);
    expect(r.reproposal_hits.some((h) => h.adr_id === 'ADR-0099')).toBe(true);
  });

  test('a clean candidate text yields no re-proposal', () => {
    const r = measureHallucination(adrs, ['plan: add a unit test for the parser.']);
    expect(r.reproposals_detected).toBe(0);
  });
});
