/**
 * CodeQL review 통합 — WI-1 배선: runner의 SARIF 산출을 evidence-store에 기록한다.
 *
 * 연구 F-6 최소 진입점: reviewer lane에서 target repo를 CodeQL 분석 → SARIF를
 * `EvidenceStore.appendRecord(kind:'artifact')`로 기록 → completion gate 증거로 연결.
 * 새 스키마 신설 없이 기존 EvidenceRecord(kind:'artifact')를 재사용한다.
 *
 * 의존 경계: reviewer profile에서 *언제* 이 함수를 자동 트리거할지는 target 언어·build
 * 재현성 판정(doctor codeql, WI-2)이 선행돼야 안전하다(부록4: Kotlin build 없으면 빈 추출을
 * '깨끗함'으로 오판). 따라서 이 함수는 호출 가능한 통합 단위로 제공하고, 자동 배선은 WI-2 뒤.
 */
import { relative } from 'node:path';
import type { z } from 'zod';
import type { EvidenceIndex, evidenceRecord } from '~/schemas/evidence-record';
import {
  type CodeqlDeps,
  type RunCodeqlInput,
  type RunCodeqlResult,
  runCodeqlAnalysis,
} from './runner';

export interface CodeqlReviewDeps extends CodeqlDeps {
  /** EvidenceStore.appendRecord 시그니처(주입 → 테스트 시 mock). */
  appendRecord: (
    workItemId: string,
    record: z.input<typeof evidenceRecord>,
  ) => Promise<EvidenceIndex>;
  sha256: (content: string) => string;
  /** ISO 8601 시각(주입 → deterministic 테스트). */
  now: () => string;
}

export interface RunCodeqlReviewInput extends RunCodeqlInput {
  workItemId: string;
}

export interface CodeqlReviewResult {
  result: RunCodeqlResult;
  evidence: EvidenceIndex;
}

/** target을 CodeQL 분석하고 SARIF를 work item 증거 원장에 artifact로 기록한다. */
export async function runCodeqlReview(
  input: RunCodeqlReviewInput,
  deps: CodeqlReviewDeps,
): Promise<CodeqlReviewResult> {
  const result = await runCodeqlAnalysis(input, deps);
  const sarifText = await deps.readText(result.sarifPath);
  const sha = deps.sha256(sarifText);
  const relPath = relative(input.repoRoot, result.sarifPath);

  const evidence = await deps.appendRecord(input.workItemId, {
    ref: {
      kind: 'artifact',
      path: relPath,
      sha256: sha,
      summary: `CodeQL ${input.language} analysis: ${result.findings.length} finding(s)${
        result.fromCache ? ' (cached)' : ''
      }`,
    },
    captured_at: deps.now(),
    freshness: 'fresh',
    stale_reason: null,
    // raw SARIF는 .ditto evidence 영역에 있으나 repo와 함께 커밋되지 않는다(gitignored).
    portability: 'local-artifact',
    artifact_available: true,
    exit_code: null,
    key_lines: result.findings
      .slice(0, 10)
      .map(
        (f) =>
          `[${f.ruleId}] ${f.file ?? '?'}:${f.startLine ?? '?'} (dataflow ${f.dataflow.length})`,
      ),
  });

  return { result, evidence };
}
