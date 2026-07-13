import { describe, expect, test } from 'bun:test';
import {
  type CompletionCoverageDeps,
  collectCompletionCoverageReport,
  isUnitOnlyClosure,
} from '~/core/completion-coverage-doctor';
import type { WorkItemSummary } from '~/core/work-item-store';
import type { CompletionContract } from '~/schemas/completion-contract';

function summary(id: string, over: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
    id,
    title: `wi ${id}`,
    status: 'in_progress',
    updated_at: '2026-06-14T00:00:00Z',
    ...over,
  };
}

type AcInput = {
  criterion_id: string;
  verdict: CompletionContract['acceptance'][number]['verdict'];
  evidence?: string[];
};

// Minimal completion fixture: collectCompletionCoverageReport only reads
// `acceptance[].verdict` and `acceptance[].evidence`, so we build a typed-narrow
// object rather than a full schema document.
function completion(workItemId: string, acs: AcInput[]): CompletionContract {
  return {
    work_item_id: workItemId,
    acceptance: acs.map((a) => ({
      criterion_id: a.criterion_id,
      verdict: a.verdict,
      evidence: (a.evidence ?? []).map((p) => ({ kind: 'file', path: p })),
      evidence_records: [],
    })),
  } as unknown as CompletionContract;
}

function deps(over: Partial<CompletionCoverageDeps> = {}): CompletionCoverageDeps {
  return {
    listWorkItems: async () => [],
    readCompletion: async () => null,
    ...over,
  };
}

describe('collectCompletionCoverageReport', () => {
  test('no work items → empty rows, zeroed totals', async () => {
    const report = await collectCompletionCoverageReport(deps());
    expect(report.rows).toEqual([]);
    expect(report.totals.work_items).toBe(0);
    expect(report.totals.total_acceptance).toBe(0);
    expect(report.totals.closed_acceptance).toBe(0);
    expect(report.totals.coverage).toBe(0);
  });

  test('work item without completion.json → zero acceptance, not an error', async () => {
    const report = await collectCompletionCoverageReport(
      deps({
        listWorkItems: async () => [summary('wi_aaaaaaaa')],
        readCompletion: async () => null,
      }),
    );
    const row = report.rows[0] as (typeof report.rows)[number];
    expect(row.work_item_id).toBe('wi_aaaaaaaa');
    expect(row.has_completion).toBe(false);
    expect(row.total_acceptance).toBe(0);
    expect(row.closed_acceptance).toBe(0);
    expect(row.coverage).toBe(0);
    expect(report.totals.work_items).toBe(1);
  });

  test('mix of closed and open ACs → exact coverage ratio', async () => {
    const report = await collectCompletionCoverageReport(
      deps({
        listWorkItems: async () => [summary('wi_aaaaaaaa')],
        readCompletion: async () =>
          completion('wi_aaaaaaaa', [
            { criterion_id: 'ac-1', verdict: 'pass', evidence: ['ev/a.txt'] },
            { criterion_id: 'ac-2', verdict: 'pass', evidence: ['ev/b.txt'] },
            { criterion_id: 'ac-3', verdict: 'unverified' },
            { criterion_id: 'ac-4', verdict: 'fail' },
          ]),
      }),
    );
    const row = report.rows[0] as (typeof report.rows)[number];
    expect(row.has_completion).toBe(true);
    expect(row.total_acceptance).toBe(4);
    expect(row.closed_acceptance).toBe(2);
    expect(row.coverage).toBe(0.5);
  });

  test('pass without evidence is NOT counted as closed (claim ≠ proof)', async () => {
    const report = await collectCompletionCoverageReport(
      deps({
        listWorkItems: async () => [summary('wi_aaaaaaaa')],
        readCompletion: async () =>
          completion('wi_aaaaaaaa', [
            { criterion_id: 'ac-1', verdict: 'pass', evidence: ['ev/a.txt'] },
            { criterion_id: 'ac-2', verdict: 'pass' }, // pass but no evidence
          ]),
      }),
    );
    const row = report.rows[0] as (typeof report.rows)[number];
    expect(row.total_acceptance).toBe(2);
    expect(row.closed_acceptance).toBe(1); // only the evidence-backed pass
    expect(row.coverage).toBe(0.5);
  });

  test('evidence_records (sidecar-wrapped) also closes a pass AC', async () => {
    const withRecord = {
      work_item_id: 'wi_aaaaaaaa',
      acceptance: [
        {
          criterion_id: 'ac-1',
          verdict: 'pass',
          evidence: [],
          evidence_records: [{ kind: 'file', path: 'ev/a.txt' }],
        },
      ],
    } as unknown as CompletionContract;
    const report = await collectCompletionCoverageReport(
      deps({
        listWorkItems: async () => [summary('wi_aaaaaaaa')],
        readCompletion: async () => withRecord,
      }),
    );
    expect((report.rows[0] as (typeof report.rows)[number]).closed_acceptance).toBe(1);
  });

  test('isUnitOnlyclosure: command-only evidence flags a unit-only closure', () => {
    const ac = {
      criterion_id: 'ac-6',
      verdict: 'pass' as const,
      evidence: [{ kind: 'command' as const, command: 'bun test tests/foo.test.ts' }],
      evidence_records: [],
    };
    expect(isUnitOnlyClosure(ac)).toBe(true);
  });

  test('isUnitOnlyclosure: a file evidence pointing at a runtime/artifact path clears the flag', () => {
    const ac = {
      criterion_id: 'ac-6',
      verdict: 'pass' as const,
      evidence: [
        { kind: 'command' as const, command: 'bun test tests/foo.test.ts' },
        { kind: 'file' as const, path: 'src/core/autopilot-loop.ts' },
      ],
      evidence_records: [],
    };
    expect(isUnitOnlyClosure(ac)).toBe(false);
  });

  test('isUnitOnlyClosure: an artifact-path evidence clears the flag', () => {
    const ac = {
      criterion_id: 'ac-6',
      verdict: 'pass' as const,
      evidence: [{ kind: 'command' as const, command: 'bun test' }],
      evidence_records: [{ kind: 'artifact' as const, path: '.ditto/local/runs/wi/coverage.json' }],
    };
    expect(isUnitOnlyClosure(ac as unknown as Parameters<typeof isUnitOnlyClosure>[0])).toBe(false);
  });

  test('isUnitOnlyClosure: a non-pass AC is never flagged (only closed ACs matter)', () => {
    const ac = {
      criterion_id: 'ac-6',
      verdict: 'unverified' as const,
      evidence: [{ kind: 'command' as const, command: 'bun test' }],
      evidence_records: [],
    };
    expect(isUnitOnlyClosure(ac)).toBe(false);
  });

  test('totals aggregate across work items', async () => {
    const map: Record<string, CompletionContract | null> = {
      wi_aaaaaaaa: completion('wi_aaaaaaaa', [
        { criterion_id: 'ac-1', verdict: 'pass', evidence: ['e'] },
        { criterion_id: 'ac-2', verdict: 'unverified' },
      ]),
      wi_bbbbbbbb: completion('wi_bbbbbbbb', [
        { criterion_id: 'ac-1', verdict: 'pass', evidence: ['e'] },
      ]),
      wi_cccccccc: null,
    };
    const report = await collectCompletionCoverageReport(
      deps({
        listWorkItems: async () => [
          summary('wi_aaaaaaaa'),
          summary('wi_bbbbbbbb'),
          summary('wi_cccccccc'),
        ],
        readCompletion: async (id) => map[id] ?? null,
      }),
    );
    expect(report.totals.work_items).toBe(3);
    expect(report.totals.with_completion).toBe(2);
    expect(report.totals.total_acceptance).toBe(3); // 2 + 1 + 0
    expect(report.totals.closed_acceptance).toBe(2); // 1 + 1 + 0
    expect(report.totals.coverage).toBeCloseTo(2 / 3, 10);
  });
});
