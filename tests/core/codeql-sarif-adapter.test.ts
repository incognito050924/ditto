import { describe, expect, test } from 'bun:test';
import type { CodeqlFinding } from '~/core/codeql/sarif';
import {
  codeqlSeverity,
  toObjection,
  toObjections,
  toReviewerFinding,
  toReviewerFindings,
} from '~/core/codeql/sarif-adapter';
import { opponentObjection } from '~/schemas/dialectic';
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

describe('toObjection', () => {
  test('produces a schema-valid objection with codeql: id and file:line oracle', () => {
    const out = toObjection(taintFinding);
    const parsed = opponentObjection.parse(out);
    expect(parsed.severity).toBe('high'); // admissible
    expect(parsed.id).toBe('codeql:js/command-line-injection@src/exec.ts:42');
    expect(parsed.maps_to).toBe('src/exec.ts:42');
    expect(parsed.failure_mode).toContain('dataflow path');
    expect(parsed.required_fix).toContain('sanitizer');
  });

  test('structural finding (no dataflow) gets a generic failure_mode/fix', () => {
    const parsed = opponentObjection.parse(toObjection(structuralFinding));
    expect(parsed.severity).toBe('medium');
    expect(parsed.failure_mode).toContain('rule matched');
    expect(parsed.id).toBe('codeql:js/biased-cryptographic-random@src/id.ts:13');
  });

  test('toObjections maps a batch, all schema-valid', () => {
    const out = toObjections([taintFinding, structuralFinding]);
    expect(out).toHaveLength(2);
    for (const o of out) opponentObjection.parse(o);
  });

  test('id falls back to ruleId when no location is present', () => {
    const noLoc: CodeqlFinding = {
      ruleId: 'js/x',
      level: null,
      file: null,
      startLine: null,
      message: null,
      dataflow: [],
    };
    const parsed = opponentObjection.parse(toObjection(noLoc));
    expect(parsed.maps_to).toBe('js/x');
    expect(parsed.id).toBe('codeql:js/x@js/x');
  });
});
