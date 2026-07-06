import { describe, expect, test } from 'bun:test';
import {
  type GreenCache,
  MAX_GREEN_TREES,
  type TreeState,
  addGreenTree,
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
