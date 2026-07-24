import { describe, expect, test } from 'bun:test';

import {
  type PushGateRecipe,
  execPushGate,
  isRepoDeclared,
  parsePushedBranches,
  pushGateDecision,
  pushGateDisposition,
  resolvePushGate,
} from './push-gate';

describe('parsePushedBranches — git pre-push stdin → pushed branch names', () => {
  test('extracts refs/heads branch names, keeping slashed names whole', () => {
    const stdin =
      'refs/heads/main abc refs/heads/main def\n' +
      'refs/heads/release/1.2 abc refs/heads/release/1.2 def\n';
    expect(parsePushedBranches(stdin)).toEqual(['main', 'release/1.2']);
  });

  test('skips a branch DELETION (local sha all-zero) — nothing to test', () => {
    const zero = '0'.repeat(40);
    const stdin = `refs/heads/gone ${zero} refs/heads/gone abcdef\n`;
    expect(parsePushedBranches(stdin)).toEqual([]);
  });

  test('ignores tags and non-heads refs, and malformed lines', () => {
    const stdin = 'refs/tags/v1 abc refs/tags/v1 def\ngarbage line\n\n';
    expect(parsePushedBranches(stdin)).toEqual([]);
  });
});

describe('pushGateDecision — fires only when a PROTECTED branch is in the push', () => {
  const config = { protected_branches: ['main'], test_command: 'bun test' };

  test('absent config → inactive (no default-on)', () => {
    expect(pushGateDecision(['main'], undefined)).toEqual({ run: false });
  });

  test('protected branch in push → run with the gate command and matched names', () => {
    expect(pushGateDecision(['main', 'feature'], config)).toEqual({
      run: true,
      test_command: 'bun test',
      matched: ['main'],
    });
  });

  test('no protected branch in push → does not run', () => {
    expect(pushGateDecision(['feature'], config)).toEqual({ run: false });
  });

  test('"*" sentinel protects EVERY pushed branch', () => {
    const all = { protected_branches: ['*'], test_command: 'bun test' };
    expect(pushGateDecision(['feature', 'wip'], all)).toEqual({
      run: true,
      test_command: 'bun test',
      matched: ['feature', 'wip'],
    });
  });
});

describe('resolvePushGate / isRepoDeclared — per-repo gate in a multi-repo workspace (ROOT-ONLY trust)', () => {
  const recipe: PushGateRecipe = {
    push_gate: { protected_branches: ['main'], test_command: 'root-test' },
    repos: [{ dir: 'sub', push_gate: { protected_branches: ['main'], test_command: 'sub-test' } }],
  };

  test('root dir ("" or ".") resolves the top-level push_gate', () => {
    expect(resolvePushGate(recipe, '')).toEqual({
      protected_branches: ['main'],
      test_command: 'root-test',
    });
    expect(resolvePushGate(recipe, '.')?.test_command).toBe('root-test');
  });

  test('a declared sub-repo dir resolves that entry gate', () => {
    expect(resolvePushGate(recipe, 'sub')?.test_command).toBe('sub-test');
    expect(resolvePushGate(recipe, './sub/')?.test_command).toBe('sub-test');
  });

  test('an undeclared dir resolves undefined (gate inactive there)', () => {
    expect(resolvePushGate(recipe, 'unknown')).toBeUndefined();
  });

  test('isRepoDeclared: only a declared nested dir is trusted; own root is not a repos[] member', () => {
    expect(isRepoDeclared(recipe, 'sub')).toBe(true);
    expect(isRepoDeclared(recipe, '')).toBe(false);
    expect(isRepoDeclared(recipe, '.')).toBe(false);
    expect(isRepoDeclared(recipe, 'unknown')).toBe(false);
  });
});

describe('pushGateDisposition — FAIL-CLOSED (deliberate asymmetry vs the barrier degrade-PROCEED)', () => {
  test('passed → gate opens (push allowed)', () => {
    expect(pushGateDisposition('passed').decision).toBe('pass');
  });

  test('failed → BLOCK (failing evidence)', () => {
    const r = pushGateDisposition('failed');
    expect(r.decision).toBe('block');
    expect(r.grounds).toContain('failed');
  });

  test('unrunnable → BLOCK (missing/unverifiable evidence never silently allows a push)', () => {
    // The push side FAILS CLOSED on the SAME `unrunnable` signal the barrier
    // degrades-to-PROCEED on — push is irreversible, completion is reversible.
    const r = pushGateDisposition('unrunnable');
    expect(r.decision).toBe('block');
    expect(r.grounds).toContain('unrunnable');
  });
});

describe('execPushGate — callable contract composing decision + cache + fail-closed disposition', () => {
  const gate = { protected_branches: ['main'], test_command: 'bun test' };
  const stdinMain = 'refs/heads/main abc refs/heads/main def\n';
  const stdinFeature = 'refs/heads/feature abc refs/heads/feature def\n';
  const passRun = () => Promise.resolve({ command: 'bun test', exitCode: 0 });
  const failRun = () => Promise.resolve({ command: 'bun test', exitCode: 1 });
  const unrunnable = () => Promise.resolve({ command: 'bun test', spawnFailed: true });

  test('non-protected push → PASS without running the test command', async () => {
    let ran = false;
    const r = await execPushGate({
      stdin: stdinFeature,
      gate,
      malformedRecipe: false,
      runTest: () => {
        ran = true;
        return passRun();
      },
    });
    expect(r.gate.decision).toBe('pass');
    expect(ran).toBe(false);
  });

  test('protected push + tests pass → PASS, and records the green tree when clean', async () => {
    const recorded: Array<{ tree: string; command: string }> = [];
    const r = await execPushGate({
      stdin: stdinMain,
      gate,
      malformedRecipe: false,
      runTest: passRun,
      treeState: { tree: 'aaa', clean: true },
      recordGreen: (tree, command) => recorded.push({ tree, command }),
    });
    expect(r.gate.decision).toBe('pass');
    expect(recorded).toEqual([{ tree: 'aaa', command: 'bun test' }]);
  });

  test('protected push + tests FAIL → BLOCK (fail-closed on failing evidence)', async () => {
    const r = await execPushGate({
      stdin: stdinMain,
      gate,
      malformedRecipe: false,
      runTest: failRun,
    });
    expect(r.gate.decision).toBe('block');
  });

  test('protected push + test command UNRUNNABLE → BLOCK (fail-closed on missing evidence)', async () => {
    let recordedCount = 0;
    const r = await execPushGate({
      stdin: stdinMain,
      gate,
      malformedRecipe: false,
      runTest: unrunnable,
      treeState: { tree: 'aaa', clean: true },
      recordGreen: () => recordedCount++,
    });
    expect(r.gate.decision).toBe('block');
    expect(recordedCount).toBe(0); // a non-pass terminal never records green
  });

  test('malformed recipe → BLOCK without running (cannot tell which branches are protected)', async () => {
    let ran = false;
    const r = await execPushGate({
      stdin: stdinMain,
      gate: undefined,
      malformedRecipe: true,
      runTest: () => {
        ran = true;
        return passRun();
      },
    });
    expect(r.gate.decision).toBe('block');
    expect(ran).toBe(false);
  });

  test('green-tree cache HIT on a clean recorded tree → PASS without re-running', async () => {
    let ran = false;
    const r = await execPushGate({
      stdin: stdinMain,
      gate,
      malformedRecipe: false,
      runTest: () => {
        ran = true;
        return passRun();
      },
      treeState: { tree: 'aaa', clean: true },
      greenCache: { trees: [{ tree: 'aaa', recorded_at: 't', command: 'bun test' }] },
    });
    expect(r.gate.decision).toBe('pass');
    expect(r.cacheHit).toBe(true);
    expect(ran).toBe(false);
  });

  test('DIRTY tree with a recorded hash → re-runs the gate (no skip)', async () => {
    let ran = false;
    const r = await execPushGate({
      stdin: stdinMain,
      gate,
      malformedRecipe: false,
      runTest: () => {
        ran = true;
        return passRun();
      },
      treeState: { tree: 'aaa', clean: false },
      greenCache: { trees: [{ tree: 'aaa', recorded_at: 't', command: 'bun test' }] },
    });
    expect(ran).toBe(true);
    expect(r.gate.decision).toBe('pass');
  });
});
