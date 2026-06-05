import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDrift, loadAssuranceSnapshots } from '~/acg/fitness/drift';
import { WorkItemStore } from '~/core/work-item-store';
import { type AcgAssuranceSnapshot, acgAssuranceSnapshot } from '~/schemas/acg-assurance-snapshot';

type Result = {
  function_id: string;
  outcome: string;
  violations?: number;
  new_violations?: number;
};
const snap = (at: string, results: Result[], change_ref = 'wi_aaaaaaaa'): AcgAssuranceSnapshot =>
  acgAssuranceSnapshot.parse({
    schema_version: '0.1.0',
    kind: 'acg.assurance-snapshot.v1',
    produced_by: 'agent',
    produced_at: at,
    at,
    trigger: 'per_change',
    change_ref,
    results,
  });

describe('computeDrift — function_id별 시계열 추세', () => {
  test('빈 입력 → snapshots 0, functions 없음', () => {
    expect(computeDrift([])).toEqual({ snapshots: 0, functions: [] });
  });

  test('violations 누증 → rising, first/last·누적 신규위반 집계', () => {
    const r = computeDrift([
      snap('2026-06-01T00:00:00.000Z', [
        { function_id: 'ff', outcome: 'pass', violations: 1, new_violations: 1 },
      ]),
      snap('2026-06-03T00:00:00.000Z', [
        { function_id: 'ff', outcome: 'fail', violations: 3, new_violations: 2 },
      ]),
    ]);
    expect(r.snapshots).toBe(2);
    const ff = r.functions.find((f) => f.function_id === 'ff');
    expect(ff?.direction).toBe('rising');
    expect(ff?.first_violations).toBe(1);
    expect(ff?.last_violations).toBe(3);
    expect(ff?.cumulative_new_violations).toBe(3);
    expect(ff?.fail_count).toBe(1);
  });

  test('순서 무관: at 오름차순으로 정렬해 추세 판단(입력이 역순이어도 falling)', () => {
    const r = computeDrift([
      snap('2026-06-05T00:00:00.000Z', [{ function_id: 'ff', outcome: 'pass', violations: 2 }]),
      snap('2026-06-01T00:00:00.000Z', [{ function_id: 'ff', outcome: 'pass', violations: 5 }]),
    ]);
    const ff = r.functions[0];
    expect(ff.points.map((p) => p.at)).toEqual([
      '2026-06-01T00:00:00.000Z',
      '2026-06-05T00:00:00.000Z',
    ]);
    expect(ff.direction).toBe('falling'); // 5 → 2
  });

  test('같은 violations → flat, violations 점 1개 이하 → insufficient', () => {
    const flat = computeDrift([
      snap('2026-06-01T00:00:00.000Z', [{ function_id: 'a', outcome: 'pass', violations: 2 }]),
      snap('2026-06-02T00:00:00.000Z', [{ function_id: 'a', outcome: 'pass', violations: 2 }]),
    ]);
    expect(flat.functions[0].direction).toBe('flat');
    const insufficient = computeDrift([
      snap('2026-06-01T00:00:00.000Z', [{ function_id: 'b', outcome: 'pass', violations: 2 }]),
    ]);
    expect(insufficient.functions[0].direction).toBe('insufficient');
  });

  test('정렬: rising이 falling보다 먼저', () => {
    const r = computeDrift([
      snap('2026-06-01T00:00:00.000Z', [
        { function_id: 'down', outcome: 'pass', violations: 9 },
        { function_id: 'up', outcome: 'pass', violations: 1 },
      ]),
      snap('2026-06-02T00:00:00.000Z', [
        { function_id: 'down', outcome: 'pass', violations: 1 },
        { function_id: 'up', outcome: 'pass', violations: 9 },
      ]),
    ]);
    expect(r.functions.map((f) => f.function_id)).toEqual(['up', 'down']); // rising 먼저
  });
});

describe('loadAssuranceSnapshots — work-item 디렉터리 스캔', () => {
  test('각 work item의 snapshot 읽고, 부재·malformed는 건너뛴다', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-drift-'));
    try {
      const store = new WorkItemStore(repo);
      const mk = () =>
        store.create({
          title: 't',
          source_request: 's',
          goal: 'g',
          acceptance_criteria: [
            { id: 'ac-1', statement: 'x', verdict: 'unverified', evidence: [] },
          ],
        });
      const a = await mk();
      const b = await mk();
      await mk(); // c: 스냅샷 없음 → skip
      const dir = (id: string) => join(repo, '.ditto', 'work-items', id);
      await writeFile(
        join(dir(a.id), 'assurance-snapshot.json'),
        JSON.stringify(
          snap('2026-06-01T00:00:00.000Z', [{ function_id: 'ff', outcome: 'pass' }], a.id),
        ),
      );
      await writeFile(join(dir(b.id), 'assurance-snapshot.json'), '{ not valid'); // malformed → skip
      const snaps = await loadAssuranceSnapshots(repo);
      expect(snaps).toHaveLength(1);
      expect(snaps[0].change_ref).toBe(a.id);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
