import { describe, expect, test } from 'bun:test';
import {
  type GreenCache,
  MAX_GREEN_TREES,
  type TreeState,
  addGreenTree,
  isTreeCleanIgnoringTrails,
  shouldRecordGreen,
  shouldSkipGate,
} from '~/core/push-gate-cache';

const clean = (tree: string): TreeState => ({ tree, clean: true });
const dirty = (tree: string): TreeState => ({ tree, clean: false });
const cache = (trees: string[]): GreenCache => ({
  trees: trees.map((t) => ({
    tree: t,
    recorded_at: '2026-07-07T00:00:00.000Z',
    command: 'bun test',
  })),
});

describe('shouldSkipGate — skip only on clean + exact tree match (ac-1/ac-2/ac-3)', () => {
  test('ac-1: clean tree whose hash is recorded green → skip', () => {
    expect(shouldSkipGate(clean('abc'), cache(['abc']))).toBe(true);
  });

  test('ac-2: DIRTY tree never skips, even when the hash is recorded green', () => {
    expect(shouldSkipGate(dirty('abc'), cache(['abc']))).toBe(false);
  });

  test('ac-3: clean tree whose hash is NOT recorded → run (no skip)', () => {
    expect(shouldSkipGate(clean('xyz'), cache(['abc', 'def']))).toBe(false);
  });

  test('ac-3: empty cache → never skips', () => {
    expect(shouldSkipGate(clean('abc'), { trees: [] })).toBe(false);
  });
});

describe('isTreeCleanIgnoringTrails — forgive untracked runtime trails, never a real change (facet 3)', () => {
  // WHY: the green-tree cache re-ran the full ~4min suite on EVERY push because
  // untracked `.ditto/work-items/` + `.ditto/memory/` runtime trails made
  // `git status --porcelain` non-empty → the tree was never "clean" → the cache never
  // hit. The clean check must FORGIVE those untracked trails (the cache key is HEAD's
  // tree, which untracked files never change) WITHOUT weakening the gate: ANY tracked/
  // staged/source change must still count DIRTY → miss. These assertions pin the
  // load-bearing predicate `status==='??' AND path under a trail prefix`. A
  // path-prefix-only impl (ignoring the status column) FAILS the tracked/staged cases
  // below, and a prefix-WITHOUT-trailing-slash impl FAILS the collision case — that is
  // exactly the gate-weakening this test forbids.

  test('untracked work-item trail → clean (ignorable)', () => {
    expect(isTreeCleanIgnoringTrails('?? .ditto/work-items/wi_x/\n')).toBe(true);
  });

  test('untracked memory event → clean (ignorable)', () => {
    expect(isTreeCleanIgnoringTrails('?? .ditto/memory/events/foo.json\n')).toBe(true);
  });

  test('TRACKED-modified file under a trail prefix → DIRTY (never forgiven)', () => {
    expect(isTreeCleanIgnoringTrails(' M .ditto/work-items/wi_x/record.json\n')).toBe(false);
  });

  test('STAGED file under a trail prefix → DIRTY (never forgiven)', () => {
    expect(isTreeCleanIgnoringTrails('M  .ditto/memory/events/foo.json\n')).toBe(false);
  });

  test('source change → DIRTY', () => {
    expect(isTreeCleanIgnoringTrails(' M src/foo.ts\n')).toBe(false);
  });

  test('untracked NEW source (not under a trail prefix) → DIRTY', () => {
    expect(isTreeCleanIgnoringTrails('?? src/newfile.ts\n')).toBe(false);
  });

  test('prefix COLLISION (sibling dir, not a child of the trail) → DIRTY', () => {
    expect(isTreeCleanIgnoringTrails('?? .ditto/work-items-x/foo\n')).toBe(false);
  });

  test('empty porcelain → clean', () => {
    expect(isTreeCleanIgnoringTrails('')).toBe(true);
  });

  test('trails ONLY (the fixed scenario) → clean', () => {
    const porcelain = '?? .ditto/work-items/wi_x/\n?? .ditto/memory/events/e.json\n';
    expect(isTreeCleanIgnoringTrails(porcelain)).toBe(true);
  });

  test('trails PLUS one real source change → DIRTY (the real change dominates)', () => {
    const porcelain = '?? .ditto/work-items/wi_x/\n?? .ditto/memory/events/e.json\n M src/foo.ts\n';
    expect(isTreeCleanIgnoringTrails(porcelain)).toBe(false);
  });
});

describe('shouldRecordGreen — record only when the run command equals the gate command AND clean (ac-4)', () => {
  test('ac-4: exact gate command on a clean tree → record', () => {
    expect(shouldRecordGreen('bun test', 'bun test', true)).toBe(true);
  });

  test('ac-4: a DIFFERENT command (subset) never records — cache poison barrier', () => {
    expect(shouldRecordGreen('bun test tests/foo', 'bun test', true)).toBe(false);
  });

  test('ac-4: exact command but DIRTY tree → do not record (tested tree ≠ HEAD tree)', () => {
    expect(shouldRecordGreen('bun test', 'bun test', false)).toBe(false);
  });
});

describe('addGreenTree — dedupe + FIFO cap', () => {
  test('adds a new tree', () => {
    const next = addGreenTree({ trees: [] }, 'abc', 'bun test', '2026-07-07T00:00:00.000Z');
    expect(next.trees.map((t) => t.tree)).toEqual(['abc']);
  });

  test('re-recording an existing tree does not duplicate (moves to newest)', () => {
    const next = addGreenTree(cache(['a', 'b']), 'a', 'bun test', '2026-07-07T00:00:00.000Z');
    expect(next.trees.map((t) => t.tree)).toEqual(['b', 'a']);
  });

  test(`caps at ${MAX_GREEN_TREES}, dropping the oldest`, () => {
    let c: GreenCache = { trees: [] };
    for (let i = 0; i < MAX_GREEN_TREES + 5; i++) {
      c = addGreenTree(c, `t${i}`, 'bun test', '2026-07-07T00:00:00.000Z');
    }
    expect(c.trees.length).toBe(MAX_GREEN_TREES);
    expect(c.trees[0]?.tree).toBe('t5'); // t0..t4 dropped
    expect(c.trees.at(-1)?.tree).toBe(`t${MAX_GREEN_TREES + 4}`);
  });
});
