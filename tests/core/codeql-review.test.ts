import { describe, expect, test } from 'bun:test';
import { type CodeqlReviewDeps, runCodeqlReview } from '~/core/codeql/review';
import type { EvidenceIndex } from '~/schemas/evidence-record';

const SARIF_WITH_FINDING = JSON.stringify({
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
          codeFlows: [
            {
              threadFlows: [
                {
                  locations: [
                    {
                      location: {
                        physicalLocation: {
                          artifactLocation: { uri: 'src/a.ts' },
                          region: { startLine: 1 },
                        },
                      },
                    },
                    {
                      location: {
                        physicalLocation: {
                          artifactLocation: { uri: 'src/exec.ts' },
                          region: { startLine: 42 },
                        },
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
});

function reviewDeps(opts: { sarif: string }): {
  deps: CodeqlReviewDeps;
  appended: Array<{ workItemId: string; record: unknown }>;
} {
  const appended: Array<{ workItemId: string; record: unknown }> = [];
  const deps: CodeqlReviewDeps = {
    // cache hit 경로로 둬서 spawn 없이 SARIF만 읽게 한다(이 테스트의 관심은 evidence 기록).
    spawn: () => {
      throw new Error('spawn should not be called on cache hit');
    },
    readText: async () => opts.sarif,
    fileExists: async () => true,
    drain: async () => '',
    appendRecord: async (workItemId, record): Promise<EvidenceIndex> => {
      appended.push({ workItemId, record });
      return { schema_version: '0.1.0', work_item_id: workItemId, records: [] };
    },
    sha256: (content) => `sha-of-${content.length}`,
    now: () => '2026-06-03T00:00:00.000Z',
  };
  return { deps, appended };
}

const baseInput = {
  workItemId: 'wi_codeql_test',
  repoRoot: '/repo',
  sourceRoot: '/repo/src',
  language: 'javascript' as const,
  commitSha: 'abcdef012345',
  dbPath: '/repo/.ditto/cache/db',
  sarifPath: '/repo/.ditto/work-items/wi_codeql_test/evidence/out.sarif',
  suite: 's.qls',
};

describe('runCodeqlReview', () => {
  test('records SARIF as an artifact evidence record with sha256 and a repo-relative path', async () => {
    const { deps, appended } = reviewDeps({ sarif: SARIF_WITH_FINDING });
    const { result, evidence } = await runCodeqlReview(baseInput, deps);

    expect(result.findings).toHaveLength(1);
    expect(evidence.work_item_id).toBe('wi_codeql_test');

    expect(appended).toHaveLength(1);
    const rec = appended[0].record as {
      ref: { kind: string; path: string; sha256: string; summary: string };
      freshness: string;
      portability: string;
      captured_at: string;
      key_lines: string[];
    };
    expect(rec.ref.kind).toBe('artifact');
    // repo-상대 경로로 정규화(절대경로가 아님).
    expect(rec.ref.path).toBe('.ditto/work-items/wi_codeql_test/evidence/out.sarif');
    expect(rec.ref.sha256).toBe(`sha-of-${SARIF_WITH_FINDING.length}`);
    expect(rec.ref.summary).toContain('1 finding');
    expect(rec.freshness).toBe('fresh');
    expect(rec.portability).toBe('local-artifact');
    expect(rec.captured_at).toBe('2026-06-03T00:00:00.000Z');
  });

  test('key_lines summarize findings as judgeable excerpts without the raw artifact', async () => {
    const { deps, appended } = reviewDeps({ sarif: SARIF_WITH_FINDING });
    await runCodeqlReview(baseInput, deps);
    const rec = appended[0].record as {
      ref: { kind: string; path: string; sha256: string; summary: string };
      freshness: string;
      portability: string;
      captured_at: string;
      key_lines: string[];
    };
    expect(rec.key_lines).toEqual(['[js/command-line-injection] src/exec.ts:42 (dataflow 2)']);
  });

  test('a clean run records zero findings (empty key_lines, summary says 0)', async () => {
    const { deps, appended } = reviewDeps({
      sarif: JSON.stringify({ version: '2.1.0', runs: [{ results: [] }] }),
    });
    const { result } = await runCodeqlReview(baseInput, deps);
    expect(result.findings).toHaveLength(0);
    const rec = appended[0].record as {
      ref: { kind: string; path: string; sha256: string; summary: string };
      freshness: string;
      portability: string;
      captured_at: string;
      key_lines: string[];
    };
    expect(rec.key_lines).toEqual([]);
    expect(rec.ref.summary).toContain('0 finding');
  });
});
