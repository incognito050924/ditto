import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { type ExecPushGateInput, execPushGate } from '~/cli/commands/push-gate';
import {
  isRepoDeclared,
  parsePushedBranches,
  pushGateDecision,
  resolvePushGate,
} from '~/core/push-gate';
import { runTestCommand } from '~/core/test-runner';
import type { RecipePushGate } from '~/schemas/recipe';

const Z = '0000000000000000000000000000000000000000';

describe('parsePushedBranches — git pre-push stdin (<local ref> <local sha> <remote ref> <remote sha>)', () => {
  test('single branch push → its remote branch name', () => {
    expect(parsePushedBranches('refs/heads/main abc refs/heads/main def\n')).toEqual(['main']);
  });

  test('multiple refs → all branch names in order', () => {
    const stdin =
      'refs/heads/main a refs/heads/main b\nrefs/heads/feature c refs/heads/feature d\n';
    expect(parsePushedBranches(stdin)).toEqual(['main', 'feature']);
  });

  test('a slashed branch name survives (refs/heads/release/1.2 → release/1.2)', () => {
    expect(parsePushedBranches('refs/heads/release/1.2 a refs/heads/release/1.2 b\n')).toEqual([
      'release/1.2',
    ]);
  });

  test('deletion (zero local sha) is skipped — nothing to test', () => {
    expect(parsePushedBranches(`(delete) ${Z} refs/heads/old ${Z}\n`)).toEqual([]);
  });

  test('non-branch remote ref (tag) is skipped', () => {
    expect(parsePushedBranches('refs/tags/v1 a refs/tags/v1 b\n')).toEqual([]);
  });

  test('empty / blank stdin → no branches', () => {
    expect(parsePushedBranches('')).toEqual([]);
    expect(parsePushedBranches('\n  \n')).toEqual([]);
  });
});

describe('pushGateDecision — fires only for a protected branch', () => {
  const cfg = { protected_branches: ['main', 'master'], test_command: 'bun test' };

  test('absent config → gate inactive', () => {
    expect(pushGateDecision(['main'], undefined)).toEqual({ run: false });
  });

  test('protected branch pushed → run with its command', () => {
    expect(pushGateDecision(['main'], cfg)).toEqual({
      run: true,
      test_command: 'bun test',
      matched: ['main'],
    });
  });

  test('non-protected branch → no run', () => {
    expect(pushGateDecision(['feature'], cfg)).toEqual({ run: false });
  });

  test('mixed push → any protected branch triggers (matched lists only protected)', () => {
    expect(pushGateDecision(['feature', 'master'], cfg)).toEqual({
      run: true,
      test_command: 'bun test',
      matched: ['master'],
    });
  });

  test('no branches (deletion-only push) → no run', () => {
    expect(pushGateDecision([], cfg)).toEqual({ run: false });
  });
});

describe('pushGateDecision — "*" wildcard protects EVERY branch (additive)', () => {
  const star = { protected_branches: ['*'], test_command: 'bun test' };

  test('"*" matches any single pushed branch (matched = the real branch name)', () => {
    expect(pushGateDecision(['feature'], star)).toEqual({
      run: true,
      test_command: 'bun test',
      matched: ['feature'],
    });
  });

  test('"*" matches ALL branches in a multi-branch push', () => {
    expect(pushGateDecision(['a', 'b'], star)).toEqual({
      run: true,
      test_command: 'bun test',
      matched: ['a', 'b'],
    });
  });

  test('"*" mixed with an exact entry still fires for an unlisted branch', () => {
    const mixed = { protected_branches: ['main', '*'], test_command: 'bun test' };
    expect(pushGateDecision(['random'], mixed)).toEqual({
      run: true,
      test_command: 'bun test',
      matched: ['random'],
    });
  });

  test('"*" with a deletion-only push (no branches) → no run', () => {
    expect(pushGateDecision([], star)).toEqual({ run: false });
  });

  test('GUARD: a non-"*" exact list still does NOT match an unlisted branch (exact path unchanged)', () => {
    expect(
      pushGateDecision(['feature'], { protected_branches: ['main'], test_command: 'bun test' }),
    ).toEqual({ run: false });
  });
});

describe("resolvePushGate — pick a repo's gate from the workspace manifest", () => {
  const manifest = {
    push_gate: { protected_branches: ['main'], test_command: 'bun test' },
    repos: [
      {
        dir: 'frontend',
        push_gate: { protected_branches: ['main'], test_command: 'turbo run test' },
      },
      { dir: 'docs' }, // declared but no gate
    ],
  };

  test('root repo ("." or "") → top-level push_gate', () => {
    expect(resolvePushGate(manifest, '.')).toEqual(manifest.push_gate);
    expect(resolvePushGate(manifest, '')).toEqual(manifest.push_gate);
  });

  test('sub-repo by dir → its own push_gate', () => {
    expect(resolvePushGate(manifest, 'frontend')).toEqual({
      protected_branches: ['main'],
      test_command: 'turbo run test',
    });
    // trailing slash / ./ prefix normalize to the same entry
    expect(resolvePushGate(manifest, './frontend/')).toEqual(manifest.repos?.[0]?.push_gate);
  });

  test('sub-repo declared without a gate → undefined (inactive)', () => {
    expect(resolvePushGate(manifest, 'docs')).toBeUndefined();
  });

  test('unknown dir → undefined', () => {
    expect(resolvePushGate(manifest, 'nope')).toBeUndefined();
  });

  test('no repos + non-root dir → undefined', () => {
    expect(resolvePushGate({ push_gate: manifest.push_gate }, 'frontend')).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// wi_260708zjt — push-gate migrates its test runner to the shared `runTestCommand`
// (single tested source) and GAINS a wall-clock timeout. The shared helper returns
// the four-terminal classification; push-gate applies the fail-closed BLOCK
// disposition: passed → allow (exit 0); failed | unrunnable | timeout → block
// (exit 1). This is the OPPOSITE of the settled-tree barrier, which degrades-PROCEEDs
// on unrunnable/timeout — push-gate BLOCKS. runTest is injected so each terminal is
// deterministic; the last case exercises the REAL runner + a short-timeout override.
// ───────────────────────────────────────────────────────────────────────────
describe('execPushGate — shared-runner terminal → fail-closed disposition (wi_260708zjt)', () => {
  const PUSH_MAIN = 'refs/heads/main a refs/heads/main b\n';
  const gate: RecipePushGate = { protected_branches: ['main'], test_command: 'bun test' };
  const input = (over: Partial<ExecPushGateInput>): ExecPushGateInput => ({
    stdin: PUSH_MAIN,
    gate,
    malformedRecipe: false,
    env: {},
    cwd: '/repo',
    runTest: async () => ({ kind: 'passed' }),
    ...over,
  });

  test('passed → allow (exit 0)', async () => {
    const r = await execPushGate(input({ runTest: async () => ({ kind: 'passed' }) }));
    expect(r.exitCode).toBe(0);
  });

  test('failed → BLOCK (exit 1)', async () => {
    const r = await execPushGate(input({ runTest: async () => ({ kind: 'failed', exitCode: 2 }) }));
    expect(r.exitCode).toBe(1);
  });

  test('unrunnable → BLOCK (exit 1) — fail-closed, NOT the barrier degrade-proceed', async () => {
    const r = await execPushGate(
      input({ runTest: async () => ({ kind: 'unrunnable', reason: 'bun: command not found' }) }),
    );
    expect(r.exitCode).toBe(1);
  });

  test('timeout → BLOCK (exit 1) — a hang blocks, never an infinite stall', async () => {
    const r = await execPushGate(
      input({ runTest: async () => ({ kind: 'timeout', timeoutMs: 50 }) }),
    );
    expect(r.exitCode).toBe(1);
  });

  test('a REAL hanging command under a short-timeout override → killed and BLOCK (ac-3)', async () => {
    const start = Date.now();
    const r = await execPushGate(
      input({
        cwd: tmpdir(), // a REAL cwd so `sleep` actually spawns (not a spawn-throw → unrunnable)
        gate: { protected_branches: ['main'], test_command: 'sleep 5' },
        // Short timeout override so the test is fast; production binds a generous ceiling.
        runTest: (cmd, cwd) => runTestCommand(cmd, cwd, { timeoutMs: 50 }),
      }),
    );
    expect(r.exitCode).toBe(1);
    // Proof it was KILLED, not that `sleep 5` ran to completion (~5000ms).
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe('isRepoDeclared — ROOT-ONLY trust anchor: is this dir a declared workspace member? (ac-3)', () => {
  const manifest = {
    repos: [{ dir: 'frontend' }, { dir: 'docs', push_gate: undefined }],
  };

  test('a declared repos[] dir → true (the root recipe adopts it)', () => {
    expect(isRepoDeclared(manifest, 'frontend')).toBe(true);
    expect(isRepoDeclared(manifest, 'docs')).toBe(true);
  });

  test('normalizes trailing slash / "./" prefix to the same declaration', () => {
    expect(isRepoDeclared(manifest, './frontend/')).toBe(true);
  });

  test('an UNDECLARED dir → false (a cloned sub-repo the root never adopted)', () => {
    expect(isRepoDeclared(manifest, 'evil')).toBe(false);
  });

  test('the recipe own root ("" / ".") is NOT a repos[] declaration → false', () => {
    expect(isRepoDeclared(manifest, '')).toBe(false);
    expect(isRepoDeclared(manifest, '.')).toBe(false);
  });

  test('a recipe with no repos[] → false for any dir', () => {
    expect(
      isRepoDeclared(
        { push_gate: { protected_branches: ['main'], test_command: 'x' } },
        'frontend',
      ),
    ).toBe(false);
  });
});
