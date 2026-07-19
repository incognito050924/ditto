import { describe, expect, test } from 'bun:test';

import { evidence, evidenceKind } from './evidence';

describe('evidence', () => {
  test('evidenceKind is exactly command/file/test/behavior/repro', () => {
    expect(evidenceKind.options).toEqual([
      'command',
      'file',
      'test',
      'behavior',
      'repro',
    ]);
  });

  test('accepts evidence carrying a path reference', () => {
    const parsed = evidence.parse({
      kind: 'file',
      path: 'rebuild/schemas/evidence.ts',
      summary: 'schema module',
    });
    expect(parsed.path).toBe('rebuild/schemas/evidence.ts');
  });

  test('accepts evidence carrying only a hash reference', () => {
    const parsed = evidence.parse({
      kind: 'test',
      hash: 'abc123',
      summary: 'test run digest',
    });
    expect(parsed.hash).toBe('abc123');
  });

  test('rejects evidence with neither path nor hash', () => {
    const result = evidence.safeParse({
      kind: 'behavior',
      summary: 'observed behavior',
    });
    expect(result.success).toBe(false);
  });

  test('rejects unknown keys that try to inline original content', () => {
    const result = evidence.safeParse({
      kind: 'file',
      path: 'x',
      summary: 'inlining attempt',
      body: 'the full original content pasted here',
    });
    expect(result.success).toBe(false);
  });

  test('requires a non-empty summary', () => {
    const result = evidence.safeParse({ kind: 'file', path: 'x', summary: '' });
    expect(result.success).toBe(false);
  });

  test('rejects a summary that inlines original content (over the cap)', () => {
    const result = evidence.safeParse({
      kind: 'file',
      path: 'x',
      summary: 'A'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  test('rejects a preview over the 2000-char bound', () => {
    const result = evidence.safeParse({
      kind: 'file',
      path: 'x',
      summary: 'bounded preview attempt',
      preview: 'A'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});
