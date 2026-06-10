import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type RegressionGateRecord,
  type RegressionJourneyOutcome,
  regressionGateRecord,
} from '~/schemas/e2e-regression-gate';
import { localDir } from '../ditto-paths';
import { writeJson } from '../fs';
import { buildFailureReport } from './failure-report';
import { type VerifyGeneratedOptions, verifyGenerated } from './generated-verify';
import {
  type ImpactedJourney,
  type RegressionSelection,
  loadJourneyEntries,
  selectImpactedJourneys,
} from './regression-select';

/**
 * 회귀 게이트 실행·기록 (wi_260610p9h ac-7).
 *
 * Selection (diff × component: surfaces — or the user-adjusted id list) →
 * verifyGenerated over the selected generated specs → persisted record at
 * `.ditto/local/work-items/<wi>/regression-gate.json`. No-escape guarantee:
 * the record keeps the selected list AND per-journey outcomes, so
 * "selected-but-failed/blocked/not-run" is machine-readable and can never be
 * closed as "이번 수정 범위 아님". Only the impacted subset runs — this module
 * never widens to the whole suite.
 */

export interface RegressionGateInput {
  workItemId: string;
  runId: string;
  changedPaths: string[];
  /** User-adjusted journey id list — REPLACES the auto selection when present. */
  journeyIds?: string[];
}

export function regressionGatePath(repoRoot: string, workItemId: string): string {
  return join(localDir(repoRoot, 'work-items', workItemId), 'regression-gate.json');
}

async function mapRunFailures(
  repoRoot: string,
  runId: string,
): Promise<{ journey_id: string; case: string }[]> {
  const reportFile = Bun.file(join(localDir(repoRoot, 'runs', runId), 'playwright-report.json'));
  if (!(await reportFile.exists())) return [];
  let reporter: unknown;
  try {
    reporter = JSON.parse(await reportFile.text());
  } catch {
    return [];
  }
  const failures = await buildFailureReport(reporter, {
    repoRoot,
    readSpec: async (specFile) => {
      try {
        return await readFile(resolve(repoRoot, specFile), 'utf8');
      } catch {
        return null;
      }
    },
  });
  return failures.map((f) => ({
    journey_id: f.journey_id === '' ? '(unmapped)' : f.journey_id,
    case: f.case_name === '' ? '(unmapped)' : f.case_name,
  }));
}

export interface RegressionGateOutcome {
  record: RegressionGateRecord;
  /** The auto selection (unmatched paths + invalid journeys, for reporting). */
  selection: RegressionSelection;
}

export async function runRegressionGate(
  repoRoot: string,
  input: RegressionGateInput,
  options: VerifyGeneratedOptions = {},
): Promise<RegressionGateOutcome> {
  const journeysDir = join(repoRoot, 'e2e', 'journeys');
  const selection = await selectImpactedJourneys(journeysDir, input.changedPaths);

  let selected: ImpactedJourney[];
  if (input.journeyIds !== undefined) {
    const { entries } = await loadJourneyEntries(journeysDir);
    selected = input.journeyIds.map((id) => {
      const auto = selection.journeys.find((j) => j.id === id);
      if (auto) return auto;
      const entry = entries.find((e) => e.id === id);
      if (!entry) throw new Error(`unknown journey id: ${id} — e2e/journeys에 해당 여정이 없다`);
      return { ...entry, matched_surfaces: [] };
    });
  } else {
    selected = selection.journeys;
  }

  const missing = selected.filter((j) => j.missing_generated);
  const runnable = selected.filter((j) => !j.missing_generated);
  const journeyResults: { journey_id: string; result: RegressionJourneyOutcome }[] = missing.map(
    (j) => ({ journey_id: j.id, result: 'not_run' as const }),
  );
  let result: RegressionGateRecord['result'];
  let reason: string;
  let failures: { journey_id: string; case: string }[] = [];

  if (selected.length === 0) {
    result = 'pass';
    reason = '영향받는 여정 없음 — 변경 경로와 교차하는 component: 표면이 없다';
  } else if (runnable.length === 0) {
    result = 'fail';
    reason = '추려진 여정 전부 generated spec 부재 — 목록에 있었는데 실행 안 됨은 pass가 아니다';
  } else {
    const verify = await verifyGenerated(
      repoRoot,
      input.runId,
      runnable.map((j) => j.generated_spec),
      options,
    );
    if (verify.result === 'blocked') {
      result = 'blocked';
      reason = verify.reason;
      for (const j of runnable) journeyResults.push({ journey_id: j.id, result: 'blocked' });
    } else if (verify.result === 'pass') {
      for (const j of runnable) journeyResults.push({ journey_id: j.id, result: 'pass' });
      if (missing.length > 0) {
        result = 'fail';
        reason = `실행된 여정은 통과했지만 ${missing.length}개 여정의 generated spec이 없다 — 추려진 목록 안에서 미실행은 실패다`;
      } else {
        result = 'pass';
        reason = verify.reason;
      }
    } else {
      result = 'fail';
      reason = verify.reason;
      failures = await mapRunFailures(repoRoot, input.runId);
      const failing = new Set(failures.map((f) => f.journey_id));
      for (const j of runnable) {
        // No mapped failures at all → cannot localize: every run journey is
        // conservatively 'fail' (the aggregate run failed; pass is unprovable).
        const failed = failures.length === 0 || failing.has(j.id);
        journeyResults.push({ journey_id: j.id, result: failed ? 'fail' : 'pass' });
      }
    }
  }

  // An unparsable journey cannot be crossed against the diff — it may well be
  // impacted. Its presence forces the gate to non-pass (fail); blocked/fail
  // stay as they are (already non-pass).
  if (selection.invalid_journeys.length > 0 && result === 'pass') {
    result = 'fail';
    reason = `${selection.invalid_journeys.length}개 journey가 front-matter 파싱 불가 — 영향 추림에서 빠졌을 수 있어 pass로 닫을 수 없다 (${selection.invalid_journeys.map((i) => i.file).join(', ')})`;
  }

  const record = await writeJson(
    regressionGatePath(repoRoot, input.workItemId),
    regressionGateRecord,
    {
      work_item: input.workItemId,
      run_id: input.runId,
      changed_paths: input.changedPaths,
      selected: selected.map((j) => ({
        id: j.id,
        name: j.name,
        description: j.description,
        journey_file: j.journey_file,
        generated_spec: j.generated_spec,
        matched_surfaces: j.matched_surfaces,
        missing_generated: j.missing_generated,
      })),
      auto_selected: selection.journeys.map((j) => j.id),
      journey_results: journeyResults,
      invalid_journeys: selection.invalid_journeys,
      result,
      failures,
      reason,
      recorded_at: new Date().toISOString(),
    },
  );
  return { record, selection };
}
