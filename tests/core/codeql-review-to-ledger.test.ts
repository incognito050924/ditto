import { describe, expect, test } from 'bun:test';
import { type CodeqlLedgerDeps, runCodeqlReviewToLedger } from '~/core/codeql/review-to-ledger';
import type { CodeqlFinding } from '~/core/codeql/sarif';
import { assembleReviewerOutput } from '~/core/codeql/sarif-adapter';
import { acgReviewForcesContinuation } from '~/hooks/stop';
import { acgReviewGraph } from '~/schemas/acg-review-graph';
import type { AcgReviewGraph } from '~/schemas/acg-review-graph';
import type { EvidenceIndex } from '~/schemas/evidence-record';
import type { ReviewerOutput } from '~/schemas/reviewer-output';
import { reviewerOutput } from '~/schemas/reviewer-output';

const highFinding: CodeqlFinding = {
  ruleId: 'js/command-line-injection',
  level: 'error',
  file: 'src/exec.ts',
  startLine: 42,
  message: 'tainted input reaches exec',
  dataflow: [
    { file: 'src/a.ts', startLine: 1, message: 'source' },
    { file: 'src/exec.ts', startLine: 42, message: 'sink' },
  ],
};
const noteFinding: CodeqlFinding = {
  ruleId: 'js/unused-local',
  level: 'note',
  file: 'src/util.ts',
  startLine: 3,
  message: 'unused',
  dataflow: [],
};

describe('assembleReviewerOutput', () => {
  test('high finding → verdict fail, schema-valid reviewer-output, severity high', () => {
    const out = assembleReviewerOutput([highFinding], {
      workItemId: 'wi_abcd1234',
      id: 'rv_abcd1234',
      startedAt: '2026-06-04T00:00:00Z',
    });
    const parsed = reviewerOutput.parse(out);
    expect(parsed.verdict).toBe('fail');
    expect(parsed.kind).toBe('security-reviewer');
    expect(parsed.reviewer).toBe('codeql');
    expect(parsed.different_provider_than_generator).toBe(false);
    expect(parsed.findings[0].severity).toBe('high');
  });

  test('only low/note findings → verdict partial', () => {
    const out = assembleReviewerOutput([noteFinding], {
      workItemId: 'wi_abcd1234',
      id: 'rv_abcd1234',
      startedAt: '2026-06-04T00:00:00Z',
    });
    expect(reviewerOutput.parse(out).verdict).toBe('partial');
  });

  test('zero findings → verdict pass', () => {
    const out = assembleReviewerOutput([], {
      workItemId: 'wi_abcd1234',
      id: 'rv_abcd1234',
      startedAt: '2026-06-04T00:00:00Z',
    });
    expect(reviewerOutput.parse(out).verdict).toBe('pass');
  });
});

const SARIF = (results: unknown[]) => JSON.stringify({ version: '2.1.0', runs: [{ results }] });

const SARIF_HIGH = SARIF([
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
]);

interface Captured {
  ledgers: Array<{ workItemId: string; graph: AcgReviewGraph }>;
  outputs: Array<{ workItemId: string; output: ReviewerOutput }>;
  spawned: number;
}

function ledgerDeps(opts: {
  sarif: string;
  cliAvailable?: boolean;
  extensions?: Record<string, number>;
}): { deps: CodeqlLedgerDeps; cap: Captured } {
  const cap: Captured = { ledgers: [], outputs: [], spawned: 0 };
  const deps: CodeqlLedgerDeps = {
    // cache-hit path: fileExists true + readText returns the fixture, so spawn is unused.
    spawn: () => {
      cap.spawned += 1;
      throw new Error('spawn should not run on cache hit');
    },
    readText: async () => opts.sarif,
    fileExists: async () => true,
    drain: async () => '',
    appendRecord: async (workItemId): Promise<EvidenceIndex> => ({
      schema_version: '0.1.0',
      work_item_id: workItemId,
      records: [],
    }),
    sha256: (c) => `sha-${c.length}`,
    now: () => '2026-06-04T00:00:00.000Z',
    collectExtensions: async () => opts.extensions ?? { ts: 12 },
    cliAvailable: async () => opts.cliAvailable ?? true,
    genReviewId: async () => 'rv_codeql0001',
    persistReviewerOutput: async (workItemId, output) => {
      cap.outputs.push({ workItemId, output });
    },
    persistLedger: async (workItemId, graph) => {
      cap.ledgers.push({ workItemId, graph });
    },
  };
  return { deps, cap };
}

const baseInput = {
  workItemId: 'wi_codeqltst1',
  repoRoot: '/repo',
  sourceRoot: '/repo/src',
  language: 'javascript' as const,
  commitSha: 'abcdef012345',
  dbPath: '/repo/.ditto/cache/db',
  sarifPath: '/repo/.ditto/work-items/wi_codeqltst1/evidence/out.sarif',
  suite: 's.qls',
};

describe('runCodeqlReviewToLedger', () => {
  test('high CodeQL finding → ledger written + blocks the Stop gate', async () => {
    const { deps, cap } = ledgerDeps({ sarif: SARIF_HIGH });
    const res = await runCodeqlReviewToLedger(baseInput, deps);

    expect(res.gated).toBe(false);
    expect(res.findings).toBe(1);
    expect(res.verdict).toBe('fail');
    expect(res.highRiskWithoutEvidence).toBe(1);
    expect(res.ledgerWritten).toBe(true);

    // The persisted ledger is schema-valid AND trips the real Stop gate.
    expect(cap.ledgers).toHaveLength(1);
    const graph = acgReviewGraph.parse(cap.ledgers[0].graph);
    const reasons = acgReviewForcesContinuation(graph);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('src/exec.ts');
    // reviewer-output persisted too (audit trail).
    expect(cap.outputs[0].output.verdict).toBe('fail');
  });

  test('doctor gate blocks (cli unavailable) → no analysis, no ledger', async () => {
    const { deps, cap } = ledgerDeps({ sarif: SARIF_HIGH, cliAvailable: false });
    const res = await runCodeqlReviewToLedger(baseInput, deps);

    expect(res.gated).toBe(true);
    expect(res.ledgerWritten).toBe(false);
    expect(cap.ledgers).toHaveLength(0);
    expect(cap.outputs).toHaveLength(0);
    expect(res.doctor.findings.some((f) => f.kind === 'cli-unavailable')).toBe(true);
  });

  test('doctor gate blocks compiled language without build verification', async () => {
    const { deps, cap } = ledgerDeps({ sarif: SARIF_HIGH, extensions: { java: 5 } });
    const res = await runCodeqlReviewToLedger({ ...baseInput, language: 'java' }, deps);
    expect(res.gated).toBe(true);
    expect(cap.ledgers).toHaveLength(0);
    expect(res.doctor.findings.some((f) => f.kind === 'compiled-language-build-unverified')).toBe(
      true,
    );
  });

  test('clean analysis → verdict pass, ledger written but does not block', async () => {
    const { deps, cap } = ledgerDeps({ sarif: SARIF([]) });
    const res = await runCodeqlReviewToLedger(baseInput, deps);
    expect(res.gated).toBe(false);
    expect(res.verdict).toBe('pass');
    expect(res.highRiskWithoutEvidence).toBe(0);
    const graph = acgReviewGraph.parse(cap.ledgers[0].graph);
    expect(acgReviewForcesContinuation(graph)).toHaveLength(0);
  });
});
