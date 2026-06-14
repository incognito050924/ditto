import { describe, expect, test } from 'bun:test';
import { coverageMap, coverageNode } from '~/schemas/coverage';

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
