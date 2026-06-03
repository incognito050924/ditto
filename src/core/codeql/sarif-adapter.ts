/**
 * SARIF → DITTO 소비처 변환 — WI-3.
 *
 * CodeQL finding을 두 모양으로 변환한다(기존 스키마 재사용, 신설 0):
 *  (a) reviewer-output `finding` — security-reviewer 출력(F-3, 거의 1:1).
 *  (b) dialectic `opponentObjection` — 결정론 opponent 주입용(WI-4 입력).
 *
 * codeFlow(source→sink)는 dataflow 증거이자 objection의 oracle 근거가 된다.
 * level→severity 매핑은 admissibility(stop.ts는 critical|high만 차단)와 직결되므로
 * taint 결과(error)가 high로 올라가게 한다.
 */
import type { z } from 'zod';
import type { severity as severitySchema } from '~/schemas/common';
import type { opponentObjection } from '~/schemas/dialectic';
import type { finding as reviewerFinding } from '~/schemas/reviewer-output';
import type { CodeqlFinding } from './sarif';

type Severity = z.infer<typeof severitySchema>;

/** SARIF level → DITTO severity. CodeQL은 error/warning/note/none을 쓴다. */
export function codeqlSeverity(level: string | null): Severity {
  switch (level) {
    case 'error':
      return 'high';
    case 'warning':
      return 'medium';
    case 'note':
    case 'recommendation':
      return 'low';
    default:
      // level 누락 = 분류 불가. 보수적으로 medium(차단은 안 하되 묻히지 않게).
      return 'medium';
  }
}

/** "file:line" oracle 문자열. 위치가 없으면 ruleId로 폴백. */
function oracleOf(f: CodeqlFinding): string {
  if (f.file) return f.startLine != null ? `${f.file}:${f.startLine}` : f.file;
  return f.ruleId;
}

/** dataflow 경로를 사람이 읽는 source→sink 요약으로. */
function dataflowSummary(f: CodeqlFinding): string {
  if (f.dataflow.length === 0) return '';
  const ends = [f.dataflow[0], f.dataflow[f.dataflow.length - 1]];
  return ` (source ${ends[0].file}:${ends[0].startLine ?? '?'} → sink ${ends[1].file}:${ends[1].startLine ?? '?'}, ${f.dataflow.length} steps)`;
}

/** (a) CodeQL finding → reviewer-output finding. */
export function toReviewerFinding(f: CodeqlFinding): z.input<typeof reviewerFinding> {
  return {
    severity: codeqlSeverity(f.level),
    ...(f.file ? { file: f.file } : {}),
    ...(f.startLine != null ? { location: `${f.startLine}` } : {}),
    reason: `${f.ruleId}: ${f.message ?? 'CodeQL finding'}${dataflowSummary(f)}`,
  };
}

export function toReviewerFindings(findings: CodeqlFinding[]): z.input<typeof reviewerFinding>[] {
  return findings.map(toReviewerFinding);
}

/**
 * (b) CodeQL finding → dialectic opponentObjection.
 * id에 `codeql:` prefix를 붙여 결정론 출처를 식별 가능하게 한다(WI-4 게이트가 사용).
 */
export function toObjection(f: CodeqlFinding): z.input<typeof opponentObjection> {
  const hasDataflow = f.dataflow.length > 0;
  return {
    severity: codeqlSeverity(f.level),
    id: `codeql:${f.ruleId}@${oracleOf(f)}`,
    claim: `${f.ruleId}: ${f.message ?? 'CodeQL detected a problem'}${dataflowSummary(f)}`,
    evidence: [],
    maps_to: oracleOf(f),
    failure_mode: hasDataflow
      ? 'Untrusted/unsafe data reaches a sensitive sink along a tracked dataflow path.'
      : 'A CodeQL rule matched at this location.',
    required_fix: hasDataflow
      ? 'Break the source→sink path with a validated sanitizer/barrier, or prove the source is trusted.'
      : 'Address the flagged pattern, or justify why it is safe in this context.',
  };
}

export function toObjections(findings: CodeqlFinding[]): z.input<typeof opponentObjection>[] {
  return findings.map(toObjection);
}
