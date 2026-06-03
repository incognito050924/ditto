/**
 * CodeQL SARIF v2.1.0 파싱 — WI-1 (CLI-free 결정론 핵심).
 *
 * CodeQL `database analyze --format=sarif-latest`가 내보내는 SARIF를,
 * 에이전트/게이트가 소비할 구조화 사실(finding + dataflow 경로)로 변환한다.
 * 우리가 소유하는 포맷이 아니라 외부 표준(OASIS SARIF)이므로, 전체를 검증하지 않고
 * **읽는 필드만** 방어적으로 추출한다(passthrough). 연구 부록1: codeFlow는 LLM 컨텍스트로
 * 쓸 만하나 snippet/severity는 SARIF 기본 미포함 → 소비처에서 보강.
 */
import { z } from 'zod';

const region = z
  .object({
    startLine: z.number().int().optional(),
    startColumn: z.number().int().optional(),
    endLine: z.number().int().optional(),
  })
  .passthrough();

const physicalLocation = z
  .object({
    artifactLocation: z.object({ uri: z.string().optional() }).passthrough().optional(),
    region: region.optional(),
  })
  .passthrough();

const location = z
  .object({
    physicalLocation: physicalLocation.optional(),
    message: z.object({ text: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const threadFlow = z
  .object({
    locations: z.array(z.object({ location: location.optional() }).passthrough()).optional(),
  })
  .passthrough();

const codeFlow = z.object({ threadFlows: z.array(threadFlow).optional() }).passthrough();

const result = z
  .object({
    ruleId: z.string().optional(),
    level: z.string().optional(),
    message: z.object({ text: z.string().optional() }).passthrough().optional(),
    locations: z.array(location).optional(),
    codeFlows: z.array(codeFlow).optional(),
  })
  .passthrough();

const sarifLog = z
  .object({
    version: z.string().optional(),
    runs: z.array(z.object({ results: z.array(result).optional() }).passthrough()).optional(),
  })
  .passthrough();

export type SarifLog = z.infer<typeof sarifLog>;

/** dataflow 경로의 한 단계: 값이 거쳐 가는 위치. */
export interface DataflowStep {
  file: string;
  startLine: number | null;
  message: string | null;
}

/** SARIF 한 건의 결과를 소비 가능한 사실로 정규화한 형태. */
export interface CodeqlFinding {
  ruleId: string;
  level: string | null;
  /** primary 위치(첫 location). */
  file: string | null;
  startLine: number | null;
  message: string | null;
  /** source→sink 경로(threadFlow를 평탄화). path-problem 쿼리에서만 채워진다. */
  dataflow: DataflowStep[];
}

function stepFrom(loc: z.infer<typeof location> | undefined): DataflowStep | null {
  const phys = loc?.physicalLocation;
  const uri = phys?.artifactLocation?.uri;
  if (uri === undefined) return null;
  return {
    file: uri,
    startLine: phys?.region?.startLine ?? null,
    message: loc?.message?.text ?? null,
  };
}

/**
 * SARIF JSON(이미 parse된 unknown 또는 문자열)을 CodeqlFinding[]로 변환한다.
 * 스키마에 안 맞으면 throw — 호출부가 CLI 산출물 손상을 감지하게 한다.
 */
export function parseSarif(input: unknown): CodeqlFinding[] {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  const log = sarifLog.parse(raw);
  const findings: CodeqlFinding[] = [];
  for (const run of log.runs ?? []) {
    for (const res of run.results ?? []) {
      const primary = stepFrom(res.locations?.[0]);
      const dataflow: DataflowStep[] = [];
      for (const flow of res.codeFlows ?? []) {
        for (const tf of flow.threadFlows ?? []) {
          for (const entry of tf.locations ?? []) {
            const step = stepFrom(entry.location);
            if (step) dataflow.push(step);
          }
        }
      }
      findings.push({
        ruleId: res.ruleId ?? '<unknown>',
        level: res.level ?? null,
        file: primary?.file ?? null,
        startLine: primary?.startLine ?? null,
        message: res.message?.text ?? null,
        dataflow,
      });
    }
  }
  return findings;
}
