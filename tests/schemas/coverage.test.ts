import { describe, expect, test } from 'bun:test';
import {
  coverageFeedback,
  coverageFeedbackEntry,
  coverageMap,
  coverageNode,
} from '~/schemas/coverage';

// N4 ac-1: dynamic-growth coverage tree schema (premortem-coverage-contract §3.1·§3.2·§9).
// Node shape { id, parent_id, label, origin, depth_weight, state, children[] };
// container { schema_version, work_item_id, nodes[], root_id }.

const WI = 'wi_abcd1234';

const node = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  parent_id: null,
  label: '최초 의도',
  origin: 'seed' as const,
  depth_weight: 1,
  state: 'open' as const,
  children: [] as string[],
  ...over,
});

const map = (over: Record<string, unknown> = {}) => ({
  schema_version: '0.1.0' as const,
  work_item_id: WI,
  root_id: 'n1',
  nodes: [
    node(),
    node({ id: 'n2', parent_id: 'n1', label: '데이터 경계', origin: 'derived', state: 'resolved' }),
  ],
  ...over,
});

describe('coverageNode', () => {
  test('valid node parses (root has parent_id null)', () => {
    expect(coverageNode.safeParse(node()).success).toBe(true);
  });

  test('rejects invalid origin enum', () => {
    expect(coverageNode.safeParse(node({ origin: 'invented' })).success).toBe(false);
  });

  test('rejects invalid state enum', () => {
    expect(coverageNode.safeParse(node({ state: 'almost' })).success).toBe(false);
  });

  test('accepts every origin and state enum value', () => {
    for (const origin of ['seed', 'derived', 'discovered']) {
      expect(coverageNode.safeParse(node({ origin })).success).toBe(true);
    }
    for (const state of ['open', 'resolved', 'user_owned', 'out_of_scope']) {
      expect(coverageNode.safeParse(node({ state })).success).toBe(true);
    }
  });
});

describe('coverageMap', () => {
  test('valid tree parses', () => {
    expect(coverageMap.safeParse(map()).success).toBe(true);
  });

  test('rejects bad work_item_id', () => {
    expect(coverageMap.safeParse(map({ work_item_id: 'nope' })).success).toBe(false);
  });

  test('serialize -> parse round-trips identically', () => {
    const original = coverageMap.parse(map());
    const round = coverageMap.parse(JSON.parse(JSON.stringify(original)));
    expect(round).toEqual(original);
  });
});

// ac-11b outcome-loop schemas: `ditto coverage feedback` input + the append-only
// ledger entry it records.

const feedbackInput = (over: Record<string, unknown> = {}) => ({
  work_item_id: WI,
  category_id: 'cov-cat-auth',
  evidence: '인증 우회로 프로덕션 장애 — auth 카테고리 미점검',
  ...over,
});

const feedbackEntry = (over: Record<string, unknown> = {}) => ({
  work_item_id: WI,
  category_id: 'cov-cat-auth',
  fault_kind: 'depth' as const,
  evidence: '인증 우회로 프로덕션 장애',
  recorded_at: '2026-06-22T10:00:00Z',
  ...over,
});

describe('coverageFeedback (input)', () => {
  test('valid input parses', () => {
    expect(coverageFeedback.safeParse(feedbackInput()).success).toBe(true);
  });

  test('rejects bad work_item_id', () => {
    expect(coverageFeedback.safeParse(feedbackInput({ work_item_id: 'nope' })).success).toBe(false);
  });

  test('rejects empty category_id', () => {
    expect(coverageFeedback.safeParse(feedbackInput({ category_id: '' })).success).toBe(false);
  });

  test('rejects empty evidence', () => {
    expect(coverageFeedback.safeParse(feedbackInput({ evidence: '' })).success).toBe(false);
  });

  test('rejects missing evidence', () => {
    const { evidence: _drop, ...rest } = feedbackInput();
    expect(coverageFeedback.safeParse(rest).success).toBe(false);
  });
});

describe('coverageFeedbackEntry (ledger row)', () => {
  test('valid entry parses', () => {
    expect(coverageFeedbackEntry.safeParse(feedbackEntry()).success).toBe(true);
  });

  test('accepts both fault_kind values', () => {
    for (const fault_kind of ['depth', 'breadth']) {
      expect(coverageFeedbackEntry.safeParse(feedbackEntry({ fault_kind })).success).toBe(true);
    }
  });

  test('rejects invalid fault_kind enum', () => {
    expect(coverageFeedbackEntry.safeParse(feedbackEntry({ fault_kind: 'sideways' })).success).toBe(
      false,
    );
  });

  test('rejects missing recorded_at', () => {
    const { recorded_at: _drop, ...rest } = feedbackEntry();
    expect(coverageFeedbackEntry.safeParse(rest).success).toBe(false);
  });

  test('rejects non-ISO recorded_at', () => {
    expect(
      coverageFeedbackEntry.safeParse(feedbackEntry({ recorded_at: 'yesterday' })).success,
    ).toBe(false);
  });

  test('serialize -> parse round-trips identically', () => {
    const original = coverageFeedbackEntry.parse(feedbackEntry());
    const round = coverageFeedbackEntry.parse(JSON.parse(JSON.stringify(original)));
    expect(round).toEqual(original);
  });
});
