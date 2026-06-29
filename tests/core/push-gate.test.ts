import { describe, expect, test } from 'bun:test';
import { parsePushedBranches, pushGateDecision, resolvePushGate } from '~/core/push-gate';

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
    expect(resolvePushGate(manifest, './frontend/')).toEqual(manifest.repos[0].push_gate);
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
