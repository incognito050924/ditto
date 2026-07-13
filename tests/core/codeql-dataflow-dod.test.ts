import { describe, expect, test } from 'bun:test';
import { toDataflowDoD, toDataflowDoDs } from '~/core/codeql/dataflow-dod';
import type { CodeqlFinding } from '~/core/codeql/sarif';

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

describe('toDataflowDoD', () => {
  test('dataflow finding → verifiable DoD proposition with source·sink file:line', () => {
    const dod = toDataflowDoD(taintFinding);
    expect(dod).not.toBeNull();
    if (dod === null) return;
    expect(dod.rule_id).toBe('js/command-line-injection');
    // source = first dataflow step, sink = last
    expect(dod.given).toContain('src/route.ts:10');
    expect(dod.when).toContain('src/exec.ts:42');
    expect(dod.then).toMatch(/sanitizer|barrier/);
    expect(dod.oracle).toBe('src/route.ts:10 → src/exec.ts:42');
  });

  test('finding without dataflow → null (no over-application to generic findings)', () => {
    expect(toDataflowDoD(structuralFinding)).toBeNull();
  });
});

describe('toDataflowDoDs', () => {
  test('mixed list → only dataflow findings yield propositions', () => {
    const dods = toDataflowDoDs([taintFinding, structuralFinding]);
    expect(dods).toHaveLength(1);
    expect((dods[0] as (typeof dods)[number]).rule_id).toBe('js/command-line-injection');
  });

  test('empty list → empty', () => {
    expect(toDataflowDoDs([])).toHaveLength(0);
  });
});
