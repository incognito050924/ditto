import { describe, expect, test } from 'bun:test';

import { analysisResult, analyzerKind } from './analyzer';

describe('analysisResult schema — the degraded/ok distinction is enforced', () => {
  test('the three analyzer kinds are the closed set', () => {
    expect(analyzerKind.options).toEqual(['codeql', 'lsp', 'semantic']);
  });

  test('an ok result round-trips with findings', () => {
    const parsed = analysisResult.parse({
      status: 'ok',
      analyzer: 'codeql',
      findings: [
        {
          rule: 'js/x',
          severity: 'error',
          path: 'a.ts',
          message: 'boom',
        },
      ],
    });
    expect(parsed.status).toBe('ok');
  });

  test('a degraded result must carry a reason and detail (no bare degraded)', () => {
    expect(() =>
      // missing reason/detail is a contract violation
      analysisResult.parse({ status: 'degraded', analyzer: 'lsp' }),
    ).toThrow();
    expect(
      analysisResult.parse({
        status: 'degraded',
        analyzer: 'lsp',
        reason: 'tool_absent',
        detail: 'not installed',
      }).status,
    ).toBe('degraded');
  });

  test('a degraded result cannot smuggle findings (strict union member)', () => {
    expect(() =>
      analysisResult.parse({
        status: 'degraded',
        analyzer: 'codeql',
        reason: 'tool_error',
        detail: 'x',
        findings: [],
      }),
    ).toThrow();
  });

  test('only the two known degraded reasons are accepted', () => {
    expect(() =>
      analysisResult.parse({
        status: 'degraded',
        analyzer: 'codeql',
        reason: 'made_up',
        detail: 'x',
      }),
    ).toThrow();
  });
});
