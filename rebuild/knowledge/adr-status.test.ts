import { describe, expect, test } from 'bun:test';

import { parseAdrStatusLine } from './adr-status';

describe('parseAdrStatusLine — the single status parser shared by projection and gates', () => {
  test('parses the Korean list line and keeps the full value text', () => {
    const body = '# ADR-0001: x\n\n- 상태: accepted (2026-06-16 설계 합의)\n- 결정 일자: 2026-06-16\n';
    expect(parseAdrStatusLine(body)).toEqual({ status: 'accepted (2026-06-16 설계 합의)' });
  });

  test('falls back to an English status line, case-insensitive', () => {
    const body = '# ADR: x\n\n- Status: Accepted\n';
    expect(parseAdrStatusLine(body)).toEqual({ status: 'Accepted' });
  });

  test('Korean line wins over an English line when both exist', () => {
    const body = '- status: english-value\n- 상태: korean-value\n';
    expect(parseAdrStatusLine(body)).toEqual({ status: 'korean-value' });
  });

  test('extracts supersededBy from a "superseded by <id>" value, tolerating a trailing annotation', () => {
    const body = '- 상태: superseded by ADR-20260722-claude-code-only-host (2026-07-22 결정)\n';
    expect(parseAdrStatusLine(body)).toEqual({
      status: 'superseded by ADR-20260722-claude-code-only-host (2026-07-22 결정)',
      supersededBy: 'ADR-20260722-claude-code-only-host',
    });
  });

  test('extracts a legacy successor id too', () => {
    const body = '- status: superseded by ADR-0016\n';
    expect(parseAdrStatusLine(body)?.supersededBy).toBe('ADR-0016');
  });

  test('is LINE-anchored — prose mentioning 상태: or superseded cannot fake a status', () => {
    const prose = '# ADR: x\n\n이 결정의 상태: 표기는 별도 라인에 있다. superseded 언급도 prose다.\n';
    expect(parseAdrStatusLine(prose)).toBeNull();
  });

  test('returns null for an empty value or a missing status line', () => {
    expect(parseAdrStatusLine('- 상태:   \n')).toBeNull();
    expect(parseAdrStatusLine('# no status here\n')).toBeNull();
  });

  test('accepts the bare (dash-less) label opening its own line', () => {
    expect(parseAdrStatusLine('상태: accepted\n')).toEqual({ status: 'accepted' });
  });
});
