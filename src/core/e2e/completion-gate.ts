import { join } from 'node:path';
import { regressionGateRecord } from '~/schemas/e2e-regression-gate';
import { regressionGatePath } from './regression-gate';
import { selectImpactedJourneys } from './regression-select';
import { detectWebSurfaceChange } from './web-surface';

/**
 * 완료측 E2E 결정론 체크 (dialectic-1 O-4/O-18, wi_260611uzs).
 *
 * The proposal trigger and the regression gate were instruction-only: nothing
 * forced them to RUN, so a driver that forgot the SKILL step closed the work
 * item with the obligations silently unmet. This module is the deterministic
 * backstop, evaluated by `ditto autopilot complete` BEFORE assembling the
 * completion contract:
 *  ① web-surface change in the work item's changed_files → an e2e proposal
 *    decision (`e2e_accept`/`e2e_decline`) must be on the ledger (ac-6 —
 *    decline satisfies it; the user deciding is the obligation, not accepting);
 *  ② changed files crossing any journey's surfaces (or unparsable journeys
 *    that defeat the crossing) → a regression-gate record must exist, cover
 *    the current changed_files, and be `pass` (ac-7).
 * Same enforcement shape as the Stop hook reading dialectic ledgers: gates are
 * called by agents, but CLOSURE is checked by the machine.
 */

export interface E2eCompletionViolation {
  code: 'proposal_missing' | 'regression_missing' | 'regression_non_pass';
  message: string;
}

export interface E2eCompletionGateInput {
  workItemId: string;
  /** The work item's accumulated repo-relative changed files. */
  changedFiles: string[];
  /** Autopilot decision ledger entries (only `decision` is consulted). */
  decisions: { decision: string }[];
}

export async function checkE2eCompletionGate(
  repoRoot: string,
  input: E2eCompletionGateInput,
): Promise<E2eCompletionViolation[]> {
  const violations: E2eCompletionViolation[] = [];

  // ① proposal decision (ac-6): a web-surface diff demands a recorded user answer.
  const detection = detectWebSurfaceChange(input.changedFiles);
  if (detection.web) {
    const decided = input.decisions.some(
      (d) => d.decision === 'e2e_accept' || d.decision === 'e2e_decline',
    );
    if (!decided) {
      violations.push({
        code: 'proposal_missing',
        message:
          `웹 표면 변경(${detection.surfaces.length} surface)이 있는데 E2E 제안 결정 레코드(e2e_accept|e2e_decline)가 없다 — ` +
          `\`ditto autopilot propose-e2e --workItem ${input.workItemId} --changedFiles <csv>\`로 사용자에게 제안하고 결정을 기록하라 (ac-6)`,
      });
    }
  }

  // ② regression gate (ac-7): impacted journeys demand a covering pass record.
  const selection = await selectImpactedJourneys(
    join(repoRoot, 'e2e', 'journeys'),
    input.changedFiles,
  );
  const impacted = selection.journeys.length > 0 || selection.invalid_journeys.length > 0;
  if (!impacted) return violations;

  const recordFile = Bun.file(regressionGatePath(repoRoot, input.workItemId));
  const demand = `\`ditto e2e regression --work-item ${input.workItemId} --changed-files <csv>\`를 실행해 기록을 남겨라 (ac-7)`;
  if (!(await recordFile.exists())) {
    violations.push({
      code: 'regression_missing',
      message: `변경과 교차하는 여정이 있는데 regression-gate 기록이 없다 — ${demand}`,
    });
    return violations;
  }
  let parsed: ReturnType<typeof regressionGateRecord.safeParse>;
  try {
    parsed = regressionGateRecord.safeParse(JSON.parse(await recordFile.text()));
  } catch {
    parsed = { success: false } as ReturnType<typeof regressionGateRecord.safeParse>;
  }
  if (!parsed.success) {
    violations.push({
      code: 'regression_missing',
      message: `regression-gate 기록이 손상되어 판독 불가 — ${demand}`,
    });
    return violations;
  }
  const covered = new Set(parsed.data.changed_paths);
  const missing = input.changedFiles.filter((p) => !covered.has(p));
  if (missing.length > 0) {
    violations.push({
      code: 'regression_missing',
      message: `regression-gate 기록이 현재 changed_files를 커버하지 않는다(미커버 ${missing.length}건: ${missing.slice(0, 3).join(', ')}…) — 최신 diff로 ${demand}`,
    });
    return violations;
  }
  if (parsed.data.result !== 'pass') {
    violations.push({
      code: 'regression_non_pass',
      message: `regression-gate 기록이 ${parsed.data.result} — 실패의 처리(기능/스크립트/환경/flaky 판정)를 닫기 전에는 완료할 수 없다: ${parsed.data.reason}`,
    });
  }
  return violations;
}
