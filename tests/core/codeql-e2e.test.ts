import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { type CodeqlDeps, runCodeqlAnalysis } from '~/core/codeql/runner';
import { spawnProviderProcess } from '~/core/hosts/spawn';

/**
 * 실제 CodeQL CLI e2e 스모크 — WI-1 done_when "실제 target 1종 e2e".
 *
 * opt-in: 느리고(~20초+) CLI를 요구하므로 기본 skip. 실행하려면:
 *   CODEQL_E2E=1 bun test tests/core/codeql-e2e.test.ts
 * codeql 바이너리는 CODEQL_BIN으로 지정(미지정 시 gh extension 기본 경로 탐색).
 */
const CODEQL_BIN =
  process.env.CODEQL_BIN ??
  `${process.env.HOME}/.local/share/gh/extensions/gh-codeql/dist/release/v2.25.5/codeql`;
const enabled = process.env.CODEQL_E2E === '1' && existsSync(CODEQL_BIN);

const realDeps: CodeqlDeps = {
  spawn: (input) => spawnProviderProcess(input),
  readText: (p) => Bun.file(p).text(),
  fileExists: (p) => Bun.file(p).exists(),
  drain: async (stream) => {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let out = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value);
    }
    return out;
  },
};

describe.skipIf(!enabled)('codeql e2e (opt-in CODEQL_E2E=1)', () => {
  const repoRoot = process.cwd();
  const outDir = '/tmp/wi1-e2e-test';

  test('analyzes ditto JS/TS source → SARIF → parsed findings, cold then cached', async () => {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    const input = {
      repoRoot,
      sourceRoot: `${repoRoot}/src`,
      language: 'javascript' as const,
      commitSha: 'e2etest00000',
      dbPath: `${outDir}/db`,
      sarifPath: `${outDir}/out.sarif`,
      suite: 'codeql/javascript-queries:codeql-suites/javascript-security-extended.qls',
      threads: 0,
      binary: CODEQL_BIN,
      download: true,
    };

    // cold run: 실제 DB 생성 → analyze → SARIF.
    const cold = await runCodeqlAnalysis(input, realDeps);
    expect(cold.fromCache).toBe(false);
    expect(cold.buildMode).toBe('none');
    expect(existsSync(input.sarifPath)).toBe(true);
    // findings는 환경마다 다를 수 있으나, 배열이어야 하고 각 항목이 정규화돼 있어야 한다.
    expect(Array.isArray(cold.findings)).toBe(true);
    for (const f of cold.findings) {
      expect(typeof f.ruleId).toBe('string');
      expect(Array.isArray(f.dataflow)).toBe(true);
    }

    // cached run: SARIF 존재 → spawn 없이 재파싱.
    const cached = await runCodeqlAnalysis(input, realDeps);
    expect(cached.fromCache).toBe(true);
    expect(cached.findings).toEqual(cold.findings);
  }, 180_000);
});
