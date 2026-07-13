import { describe, expect, test } from 'bun:test';
import { type SarifLog, parseSarif } from '~/core/codeql/sarif';

// 부록2 PoC-1 형태의 최소 SARIF: command-injection path-problem 1건 + codeFlow 3단계.
const COMMAND_INJECTION_SARIF: SarifLog = {
  version: '2.1.0',
  runs: [
    {
      results: [
        {
          ruleId: 'js/command-line-injection',
          level: 'error',
          message: { text: 'This command depends on user-provided value.' },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: 'src/exec.ts' },
                region: { startLine: 42 },
              },
            },
          ],
          codeFlows: [
            {
              threadFlows: [
                {
                  locations: [
                    {
                      location: {
                        physicalLocation: {
                          artifactLocation: { uri: 'src/route.ts' },
                          region: { startLine: 10 },
                        },
                        message: { text: 'req.query.cmd' },
                      },
                    },
                    {
                      location: {
                        physicalLocation: {
                          artifactLocation: { uri: 'src/middleware.ts' },
                          region: { startLine: 7 },
                        },
                        message: { text: 'forwarded value' },
                      },
                    },
                    {
                      location: {
                        physicalLocation: {
                          artifactLocation: { uri: 'src/exec.ts' },
                          region: { startLine: 42 },
                        },
                        message: { text: 'execSync(cmd)' },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe('parseSarif', () => {
  test('extracts finding identity, primary location, and message', () => {
    const findings = parseSarif(COMMAND_INJECTION_SARIF);
    expect(findings).toHaveLength(1);
    const f = findings[0] as (typeof findings)[number];
    expect(f.ruleId).toBe('js/command-line-injection');
    expect(f.level).toBe('error');
    expect(f.file).toBe('src/exec.ts');
    expect(f.startLine).toBe(42);
    expect(f.message).toContain('user-provided');
  });

  test('flattens codeFlow into an ordered source→sink dataflow path', () => {
    const f = parseSarif(COMMAND_INJECTION_SARIF)[0] as ReturnType<typeof parseSarif>[number];
    expect(f.dataflow).toEqual([
      { file: 'src/route.ts', startLine: 10, message: 'req.query.cmd' },
      { file: 'src/middleware.ts', startLine: 7, message: 'forwarded value' },
      { file: 'src/exec.ts', startLine: 42, message: 'execSync(cmd)' },
    ]);
  });

  test('accepts a JSON string as well as a parsed object', () => {
    const findings = parseSarif(JSON.stringify(COMMAND_INJECTION_SARIF));
    expect(findings).toHaveLength(1);
    expect((findings[0] as (typeof findings)[number]).ruleId).toBe('js/command-line-injection');
  });

  test('returns empty for a clean run with no results', () => {
    expect(parseSarif({ version: '2.1.0', runs: [{ results: [] }] })).toEqual([]);
    expect(parseSarif({ version: '2.1.0', runs: [] })).toEqual([]);
  });

  test('tolerates a structure-only finding with no dataflow', () => {
    const findings = parseSarif({
      runs: [
        {
          results: [
            {
              ruleId: 'js/ditto/direct-exec',
              locations: [
                {
                  physicalLocation: { artifactLocation: { uri: 'a.ts' }, region: { startLine: 3 } },
                },
              ],
            },
          ],
        },
      ],
    });
    expect((findings[0] as (typeof findings)[number]).dataflow).toEqual([]);
    expect((findings[0] as (typeof findings)[number]).level).toBeNull();
    expect((findings[0] as (typeof findings)[number]).file).toBe('a.ts');
  });

  test('throws on malformed SARIF (runs not an array)', () => {
    expect(() => parseSarif({ version: '2.1.0', runs: 'nope' })).toThrow();
  });
});
