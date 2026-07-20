import { describe, expect, test } from 'bun:test';

import {
  codexCrossCheck,
  upgradesToPass,
  type CodexDeps,
} from './codex';

const claim = { claim: 'ac-6 slice test passes', evidence: 'bun test rebuild/ → 0' };

function depsThatRun(
  exitCode: number,
  lastMessage: string,
): CodexDeps {
  return {
    which: () => '/usr/local/bin/codex',
    run: () => ({ exitCode, lastMessage, stderr: '' }),
  };
}

describe('codexCrossCheck — absence is fail-closed (ac-3 core)', () => {
  test('codex CLI absent → unverified, never upgraded', () => {
    const deps: CodexDeps = { which: () => null, run: () => ({ exitCode: 0, lastMessage: 'VERDICT: verified', stderr: '' }) };
    const r = codexCrossCheck(claim, deps);
    expect(r.outcome).toBe('unverified');
    expect(r.codexAvailable).toBe(false);
    expect(upgradesToPass(r.outcome)).toBe(false);
  });
});

describe('codexCrossCheck — present path (maker≠checker)', () => {
  test('explicit VERDICT: verified → verified (upgrades)', () => {
    const r = codexCrossCheck(claim, depsThatRun(0, 'looks right.\nVERDICT: verified'));
    expect(r.outcome).toBe('verified');
    expect(r.codexAvailable).toBe(true);
    expect(upgradesToPass(r.outcome)).toBe(true);
  });

  test('explicit VERDICT: refuted → refuted (does NOT upgrade)', () => {
    const r = codexCrossCheck(claim, depsThatRun(0, 'the claim is wrong.\nVERDICT: refuted'));
    expect(r.outcome).toBe('refuted');
    expect(upgradesToPass(r.outcome)).toBe(false);
  });

  test('codex runs but exits non-zero → unverified (fail-closed)', () => {
    const r = codexCrossCheck(claim, depsThatRun(1, 'VERDICT: verified'));
    expect(r.outcome).toBe('unverified');
    expect(upgradesToPass(r.outcome)).toBe(false);
  });

  test('ambiguous output with no clear verdict → unverified (fail-closed)', () => {
    const r = codexCrossCheck(claim, depsThatRun(0, 'hmm, hard to say either way'));
    expect(r.outcome).toBe('unverified');
    expect(upgradesToPass(r.outcome)).toBe(false);
  });

  test('output claiming both → refuted wins (fail-closed toward blocking)', () => {
    const r = codexCrossCheck(claim, depsThatRun(0, 'VERDICT: verified\nactually VERDICT: refuted'));
    expect(r.outcome).toBe('refuted');
    expect(upgradesToPass(r.outcome)).toBe(false);
  });
});

describe('upgradesToPass', () => {
  test('only verified upgrades', () => {
    expect(upgradesToPass('verified')).toBe(true);
    expect(upgradesToPass('refuted')).toBe(false);
    expect(upgradesToPass('unverified')).toBe(false);
  });
});
