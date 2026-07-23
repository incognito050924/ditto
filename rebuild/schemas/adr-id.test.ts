import { describe, expect, test } from 'bun:test';

import {
  ADR_FILENAME_RE,
  ADR_ID_EXTRACT_RE,
  ADR_ID_FULL_RE,
  ADR_SLUG_RE,
  ADR_TITLE_PREFIX_RE,
  adrIdFromFilename,
} from './adr-id';

describe('ADR id grammar — the immutable-filename identifier policy', () => {
  test('full-id validator accepts legacy ADR-NNNN and new ADR-YYYYMMDD-<slug>', () => {
    expect(ADR_ID_FULL_RE.test('ADR-0013')).toBe(true);
    expect(ADR_ID_FULL_RE.test('ADR-20260624-adr-identifier-policy')).toBe(true);
  });

  test('full-id validator rejects malformed ids', () => {
    expect(ADR_ID_FULL_RE.test('ADR-13')).toBe(false); // not 4 digits
    expect(ADR_ID_FULL_RE.test('ADR-20260624')).toBe(false); // new form needs a slug
    expect(ADR_ID_FULL_RE.test('ADR-20260624-')).toBe(false); // trailing hyphen
    expect(ADR_ID_FULL_RE.test('ADR-20260624-My-Slug')).toBe(false); // uppercase
    expect(ADR_ID_FULL_RE.test('adr-0013')).toBe(false); // lowercase prefix
    expect(ADR_ID_FULL_RE.test('ADR-0013-extra')).toBe(false); // legacy id is number only
  });

  test('extraction matcher takes the 8-digit branch first so a date id is never truncated to 4 digits', () => {
    expect('ADR-20260624-adr-identifier-policy.md'.match(ADR_ID_EXTRACT_RE)?.[0]).toBe(
      'ADR-20260624-adr-identifier-policy',
    );
    expect('ADR-0013-memory-subsystem-design.md'.match(ADR_ID_EXTRACT_RE)?.[0]).toBe('ADR-0013');
  });

  test('title-prefix matcher strips the id and separator off an ADR title line', () => {
    expect('ADR-0013: 메모리 서브시스템 설계'.replace(ADR_TITLE_PREFIX_RE, '')).toBe(
      '메모리 서브시스템 설계',
    );
    expect('ADR-20260624-adr-identifier-policy: ADR 식별자'.replace(ADR_TITLE_PREFIX_RE, '')).toBe(
      'ADR 식별자',
    );
  });

  test('filename matcher requires a slug after the number — bare ids are malformed filenames', () => {
    expect(ADR_FILENAME_RE.test('ADR-0013-memory-subsystem-design.md')).toBe(true);
    expect(ADR_FILENAME_RE.test('ADR-20260624-adr-identifier-policy.md')).toBe(true);
    expect(ADR_FILENAME_RE.test('ADR-0013.md')).toBe(false);
    expect(ADR_FILENAME_RE.test('ADR-20260624.md')).toBe(false);
    expect(ADR_FILENAME_RE.test('ADR-xyz.md')).toBe(false);
    expect(ADR_FILENAME_RE.test('notes.md')).toBe(false);
  });

  test('slug validator rejects uppercase, underscores, hyphen abuse, and empties', () => {
    expect(ADR_SLUG_RE.test('my-feature')).toBe(true);
    expect(ADR_SLUG_RE.test('a1-b2-c3')).toBe(true);
    expect(ADR_SLUG_RE.test('')).toBe(false);
    expect(ADR_SLUG_RE.test('My-Feature')).toBe(false);
    expect(ADR_SLUG_RE.test('my_feature')).toBe(false);
    expect(ADR_SLUG_RE.test('-lead')).toBe(false);
    expect(ADR_SLUG_RE.test('trail-')).toBe(false);
    expect(ADR_SLUG_RE.test('double--hyphen')).toBe(false);
  });

  test('adrIdFromFilename gates on a whole well-formed filename, then extracts the id', () => {
    expect(adrIdFromFilename('ADR-0013-memory-subsystem-design.md')).toBe('ADR-0013');
    expect(adrIdFromFilename('ADR-20260624-adr-identifier-policy.md')).toBe(
      'ADR-20260624-adr-identifier-policy',
    );
    expect(adrIdFromFilename('ADR-0013.md')).toBeNull();
    expect(adrIdFromFilename('README.md')).toBeNull();
    expect(adrIdFromFilename('ADR-20260624-Bad-Case.md')).toBeNull();
  });
});
