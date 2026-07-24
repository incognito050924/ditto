import { describe, expect, test } from 'bun:test';

import {
  EMPTY_CACHE,
  MAX_GREEN_TREES,
  addGreenTree,
  greenCachePath,
  isTreeCleanIgnoringTrails,
  shouldRecordGreen,
  shouldSkipGate,
} from './push-gate-cache';

describe('isTreeCleanIgnoringTrails — clean iff every porcelain line is a forgiven untracked trail', () => {
  test('empty porcelain is clean', () => {
    expect(isTreeCleanIgnoringTrails('')).toBe(true);
  });

  test('only untracked ditto runtime trails is clean (byproduct of merely running)', () => {
    const porcelain = '?? .ditto/work-items/wi_x/events/1.json\n?? .ditto/memory/events/2.json\n';
    expect(isTreeCleanIgnoringTrails(porcelain)).toBe(true);
  });

  test('a tracked-modified file is dirty even when it lives under a trail prefix', () => {
    // ` M path` — worktree-modified TRACKED file (not `??`); must never be forgiven.
    expect(isTreeCleanIgnoringTrails(' M .ditto/work-items/wi_x/record.json\n')).toBe(false);
  });

  test('an untracked file OUTSIDE a trail prefix is dirty', () => {
    expect(isTreeCleanIgnoringTrails('?? src/new-file.ts\n')).toBe(false);
  });

  test('a sibling dir that only prefix-shares the trail must NOT be forgiven (trailing slash load-bearing)', () => {
    expect(isTreeCleanIgnoringTrails('?? .ditto/work-items-x/leak.json\n')).toBe(false);
  });
});

describe('shouldSkipGate — skip only a clean tree whose exact hash is a recorded green', () => {
  const cache = { trees: [{ tree: 'aaa', recorded_at: 't', command: 'bun test' }] };

  test('clean tree with a recorded hash skips', () => {
    expect(shouldSkipGate({ tree: 'aaa', clean: true }, cache)).toBe(true);
  });

  test('dirty tree never skips even when the hash is recorded (tested content ≠ HEAD tree)', () => {
    expect(shouldSkipGate({ tree: 'aaa', clean: false }, cache)).toBe(false);
  });

  test('unknown hash never skips', () => {
    expect(shouldSkipGate({ tree: 'bbb', clean: true }, cache)).toBe(false);
  });

  test('empty cache never skips', () => {
    expect(shouldSkipGate({ tree: 'aaa', clean: true }, EMPTY_CACHE)).toBe(false);
  });
});

describe('shouldRecordGreen — record only when the run command IS the gate command AND tree was clean', () => {
  test('identical command on a clean tree records', () => {
    expect(shouldRecordGreen('bun test', 'bun test', true)).toBe(true);
  });

  test('a subset/different command never records (proves nothing about the full gate)', () => {
    expect(shouldRecordGreen('bun test rebuild/', 'bun test', true)).toBe(false);
  });

  test('a dirty tree never records', () => {
    expect(shouldRecordGreen('bun test', 'bun test', false)).toBe(false);
  });
});

describe('addGreenTree — dedupe newest-wins, FIFO-capped', () => {
  test('dedupes on tree hash, newest recorded_at wins', () => {
    const c1 = addGreenTree(EMPTY_CACHE, 'aaa', 'bun test', 't1');
    const c2 = addGreenTree(c1, 'aaa', 'bun test', 't2');
    expect(c2.trees).toEqual([{ tree: 'aaa', recorded_at: 't2', command: 'bun test' }]);
  });

  test('caps at MAX_GREEN_TREES, dropping oldest first', () => {
    let cache = EMPTY_CACHE;
    for (let i = 0; i < MAX_GREEN_TREES + 5; i++) {
      cache = addGreenTree(cache, `tree${i}`, 'bun test', `t${i}`);
    }
    expect(cache.trees.length).toBe(MAX_GREEN_TREES);
    expect(cache.trees[0]?.tree).toBe(`tree${5}`); // first 5 dropped
    expect(cache.trees.at(-1)?.tree).toBe(`tree${MAX_GREEN_TREES + 4}`);
  });
});

describe('greenCachePath — per-machine gitignored cache under .ditto/local', () => {
  test('routes through the tier-③ local dir', () => {
    expect(greenCachePath('/repo')).toBe('/repo/.ditto/local/push-gate-green.json');
  });
});
