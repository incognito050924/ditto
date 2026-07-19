import { describe, expect, test } from 'bun:test';
import type { CodeqlFinding } from '~/core/codeql/sarif';
import {
  codeqlSeverity,
  toReviewerFinding,
  toReviewerFindings,
} from '~/core/codeql/sarif-adapter';
import { finding as reviewerFinding } from '~/schemas/reviewer-output';

const taintFinding: CodeqlFinding = {
  ruleId: 'js/command-line-injection',
  level: 'error',
  file: 'src/exec.ts',
  startLine: 42,
  message: 'command depends on user input',
  dataflow: [
    { file: 'src/route.ts', startLine: 10, message: 'req.query.cmd' },
    { file: 'src/exec.ts', startLine: 42, message: 'execSync(cmd)' },
  ],
};

const structuralFinding: CodeqlFinding = {
  ruleId: 'js/biased-cryptographic-random',
  level: 'warning',
  file: 'src/id.ts',
  startLine: 13,
  message: 'weak randomness',
  dataflow: [],
};

describe('codeqlSeverity', () => {
  test('maps CodeQL levels to DITTO severity (error→high admissible)', () => {
    expect(codeqlSeverity('error')).toBe('high');
    expect(codeqlSeverity('warning')).toBe('medium');
    expect(codeqlSeverity('note')).toBe('low');
    expect(codeqlSeverity(null)).toBe('medium'); // 보수적 폴백
  });
});

describe('toReviewerFinding', () => {
  test('produces a schema-valid reviewer finding with dataflow summary', () => {
    const out = toReviewerFinding(taintFinding);
    const parsed = reviewerFinding.parse(out); // 실제 스키마 라운드트립
    expect(parsed.severity).toBe('high');
    expect(parsed.file).toBe('src/exec.ts');
    expect(parsed.location).toBe('42');
    expect(parsed.reason).toContain('js/command-line-injection');
    expect(parsed.reason).toContain('source src/route.ts:10 → sink src/exec.ts:42');
  });

  test('toReviewerFindings maps a batch', () => {
    const out = toReviewerFindings([taintFinding, structuralFinding]);
    expect(out).toHaveLength(2);
    for (const f of out) reviewerFinding.parse(f);
  });
});
