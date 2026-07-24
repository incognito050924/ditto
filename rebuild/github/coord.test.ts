import { describe, expect, test } from 'bun:test';

import {
  canonicalizeRepo,
  formatCoord,
  parseCoord,
  sameRepoCoord,
  type RepoCoord,
} from './coord';

describe('github coordinate — owner/repo#n (ADR-20260628 D4)', () => {
  test('parseCoord reads a well-formed owner/repo#n token', () => {
    expect(parseCoord('octo/app#42')).toEqual({ repo: 'octo/app', number: 42 });
  });

  test('parseCoord trims surrounding whitespace', () => {
    expect(parseCoord('  octo/app#7  ')).toEqual({ repo: 'octo/app', number: 7 });
  });

  test('parseCoord returns null on malformed tokens (no number, no slash, extra #)', () => {
    expect(parseCoord('octo/app')).toBeNull();
    expect(parseCoord('app#42')).toBeNull();
    expect(parseCoord('octo/app#')).toBeNull();
    expect(parseCoord('octo/app#0x1')).toBeNull();
    expect(parseCoord('octo/a/b#1')).toBeNull();
    expect(parseCoord('')).toBeNull();
  });

  test('formatCoord is the inverse of parseCoord (round-trip)', () => {
    const coord: RepoCoord = { repo: 'octo/app', number: 42 };
    expect(formatCoord(coord)).toBe('octo/app#42');
    expect(parseCoord(formatCoord(coord))).toEqual(coord);
  });

  test('canonicalizeRepo lowercases and strips a trailing .git', () => {
    expect(canonicalizeRepo('Octo/App.git')).toBe('octo/app');
    expect(canonicalizeRepo('  OCTO/APP  ')).toBe('octo/app');
  });

  test('sameRepoCoord compares case-insensitively / .git-insensitively', () => {
    expect(sameRepoCoord('Octo/App', 'octo/app.git')).toBe(true);
    expect(sameRepoCoord('octo/app', 'octo/other')).toBe(false);
  });
});
