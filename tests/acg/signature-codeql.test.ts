import { describe, expect, test } from 'bun:test';
import {
  diffSignatureMaps,
  formatSignature,
  rowsToSignatureMap,
  signatureQuery,
} from '~/acg/semantic/signature-codeql';

// O7 (wi_260605de1) — pure parts of the CodeQL signature extractor (CLI-free).
// The real extraction is verified separately under CODEQL_E2E; here we pin the
// fail-loud language binding and the row→map→diff logic.

describe('signatureQuery — fail-loud language binding', () => {
  test('javascript is bound', () => {
    expect(signatureQuery('javascript')).toContain('isExportedFn');
  });

  test('an unbound language throws (never a silent empty result)', () => {
    // The 1차 bug was a silent TS-only false-clean; an unbound language must fail.
    expect(() => signatureQuery('ruby')).toThrow(/not bound for language 'ruby'/);
  });

  // wi_260605ml1 (A) — multi-language signature bindings.
  test('java is bound (public-method API surface, type reconstruction)', () => {
    const q = signatureQuery('java');
    expect(q).toContain('import java');
    expect(q).toContain('isExportedMethod');
    expect(q).toContain('getParameterType'); // reconstructs types, not text
  });

  test('kotlin reuses the java query (java-kotlin extractor, identical AST)', () => {
    expect(signatureQuery('kotlin')).toBe(signatureQuery('java'));
  });

  test('python is bound (param-names model — dynamic typing, no return type)', () => {
    const q = signatureQuery('python');
    expect(q).toContain('import python');
    expect(q).toContain('isModuleLevel');
    expect(q).toContain('asName().getId()'); // param names, not annotations
  });

  test('a still-unbound language (go) fails loud with the supported set', () => {
    expect(() => signatureQuery('go')).toThrow(
      /not bound for language 'go'.*javascript, java, kotlin, python/,
    );
  });
});

describe('formatSignature', () => {
  test('includes the return type when present', () => {
    expect(formatSignature('getUser', 'id: string', 'User | null')).toBe(
      'getUser(id: string): User | null',
    );
  });

  test('omits the colon when there is no return type', () => {
    expect(formatSignature('noArgs', '', '')).toBe('noArgs()');
  });
});

describe('rowsToSignatureMap', () => {
  test('keys on file::symbol so same-named exports stay distinct', () => {
    const map = rowsToSignatureMap([
      ['a.ts', 'f', 'x: number', 'number'],
      ['b.ts', 'f', 'x: string', 'string'],
    ]);
    expect(map.get('a.ts::f')?.signature).toBe('f(x: number): number');
    expect(map.get('b.ts::f')?.signature).toBe('f(x: string): string');
  });

  test('skips rows missing a file or name', () => {
    const map = rowsToSignatureMap([
      ['', 'f', '', ''],
      ['a.ts', '', '', ''],
    ]);
    expect(map.size).toBe(0);
  });
});

describe('diffSignatureMaps', () => {
  const before = rowsToSignatureMap([
    ['user.ts', 'getUser', 'id: string', 'User | null'],
    ['user.ts', 'keep', 'a: number', 'number'],
    ['user.ts', 'removed', '', 'void'],
  ]);

  test('reports only symbols present in both with a differing signature', () => {
    const after = rowsToSignatureMap([
      ['user.ts', 'getUser', 'id: string', 'User'],
      ['user.ts', 'keep', 'a: number', 'number'],
      ['user.ts', 'added', 'x: string', 'void'],
    ]);
    const changes = diffSignatureMaps(before, after);
    expect(changes).toEqual([
      {
        file: 'user.ts',
        symbol: 'getUser',
        before: 'getUser(id: string): User | null',
        after: 'getUser(id: string): User',
      },
    ]);
  });

  test('no changes when signatures are identical', () => {
    expect(diffSignatureMaps(before, before)).toEqual([]);
  });

  test('a deleted export is not a signature-shape change', () => {
    const after = rowsToSignatureMap([
      ['user.ts', 'getUser', 'id: string', 'User | null'],
      ['user.ts', 'keep', 'a: number', 'number'],
    ]);
    expect(diffSignatureMaps(before, after)).toEqual([]);
  });
});
