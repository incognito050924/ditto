import { describe, expect, test } from 'bun:test';
import {
  codeqlFindingToViolation,
  sarifFindingsToViolationIds,
  sarifToViolationIds,
} from '~/acg/fitness/codeql-provider';
import { normalizeViolationIdentity } from '~/acg/fitness/fitness-runner';
import type { CodeqlFinding } from '~/core/codeql/sarif';

const finding = (overrides: Partial<CodeqlFinding> = {}): CodeqlFinding => ({
  ruleId: 'js/command-line-injection',
  level: 'error',
  file: 'src/exec.ts',
  startLine: 42,
  message: 'tainted command',
  dataflow: [],
  ...overrides,
});

describe('codeqlFindingToViolation', () => {
  test('maps rule + path, dropping the raw line (OBJ-11)', () => {
    const v = codeqlFindingToViolation(finding());
    expect(v).toEqual({ rule: 'js/command-line-injection', path: 'src/exec.ts' });
    // identity must not encode the line so a line move is not a new violation
    expect(normalizeViolationIdentity(v)).toBe('js/command-line-injection@src/exec.ts#<top>');
    expect(normalizeViolationIdentity(v)).not.toContain('42');
  });

  test('a missing file becomes <nopath>, never undefined-in-key', () => {
    expect(normalizeViolationIdentity(codeqlFindingToViolation(finding({ file: null })))).toBe(
      'js/command-line-injection@<nopath>#<top>',
    );
  });
});

describe('sarifFindingsToViolationIds', () => {
  test('two findings of the same rule+file collapse to one identity (conservative)', () => {
    const ids = sarifFindingsToViolationIds([
      finding({ startLine: 42 }),
      finding({ startLine: 99 }),
    ]);
    expect(ids).toEqual(['js/command-line-injection@src/exec.ts#<top>']);
  });

  test('distinct rule/file pairs stay distinct', () => {
    const ids = sarifFindingsToViolationIds([
      finding({ ruleId: 'js/sql-injection' }),
      finding({ file: 'src/other.ts' }),
    ]);
    expect(new Set(ids).size).toBe(2);
  });

  test('a line move keeps the same identity (delta_only would not flag it new)', () => {
    expect(sarifFindingsToViolationIds([finding({ startLine: 10 })])).toEqual(
      sarifFindingsToViolationIds([finding({ startLine: 500 })]),
    );
  });
});

describe('sarifToViolationIds (full SARIF text → ids)', () => {
  const SARIF = JSON.stringify({
    version: '2.1.0',
    runs: [
      {
        results: [
          {
            ruleId: 'js/command-line-injection',
            level: 'error',
            message: { text: 'tainted' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'src/exec.ts' },
                  region: { startLine: 42 },
                },
              },
            ],
          },
        ],
      },
    ],
  });

  test('parses a SARIF document and projects it to the violation-identity set', () => {
    expect(sarifToViolationIds(SARIF)).toEqual(['js/command-line-injection@src/exec.ts#<top>']);
  });

  test('an empty SARIF yields no violations', () => {
    expect(sarifToViolationIds(JSON.stringify({ version: '2.1.0', runs: [] }))).toEqual([]);
  });
});
