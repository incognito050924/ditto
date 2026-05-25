import { describe, expect, test } from 'bun:test';
import { profileUnverified } from '~/core/run-with';

describe('profileUnverified — wi_v03sandbox AC-5 case (b)/(c) defense-in-depth', () => {
  test('returns no findings when there are no changed files', () => {
    for (const profile of [
      'read-only',
      'workspace-write',
      'reviewer',
      'networked',
      'isolated',
    ] as const) {
      expect(profileUnverified(profile, [])).toEqual([]);
    }
  });

  test('workspace-write tolerates writes inside the repo (case c negative)', () => {
    expect(profileUnverified('workspace-write', ['src/foo.ts', 'docs/bar.md'])).toEqual([]);
  });

  test('read-only flags any write as profile violation (case c positive)', () => {
    expect(profileUnverified('read-only', ['src/foo.ts'])).toContain(
      'profile violated: writes detected',
    );
  });

  test('reviewer flags any write as profile violation (case c positive)', () => {
    expect(profileUnverified('reviewer', ['notes.md'])).toContain(
      'profile violated: writes detected',
    );
  });

  test('surfaces changed files that escape the repo as a separate unverified entry (case b)', () => {
    const findings = profileUnverified('workspace-write', ['src/foo.ts', '../escape.txt']);
    expect(findings).toContain('profile violated: changed files outside repo: ../escape.txt');
    expect(findings).not.toContain('profile violated: writes detected');
  });

  test('read-only stacks both findings when escape paths appear alongside in-repo writes (case b + c)', () => {
    const findings = profileUnverified('read-only', ['src/foo.ts', '/abs/escape.txt']);
    expect(findings).toContain('profile violated: changed files outside repo: /abs/escape.txt');
    expect(findings).toContain('profile violated: writes detected');
  });
});
