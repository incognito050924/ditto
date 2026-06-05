import { z } from 'zod';
import { acgProducedBy } from './acg-common';
import { isoDateTime, schemaVersion } from './common';

/**
 * ACG FitnessVerdict — 에이전트가 미리 산출한 fitness 판정 파일. ditto는 LLM이나
 * 테스트를 직접 호출하지 않는다(절대 불변식). llm_judged/executed mode의 fitness
 * function은 에이전트가 외부에서 평가한 뒤 이 파일로 verdict를 주입하고, provider가
 * 소비한다.
 *
 * fail-closed가 최우선: llm_judged는 reproducibility(model_version 등)가 없으면
 * 스키마가 거부한다(증거 없는 pass 금지). executed는 evidence_ref로 재현 출처를 남긴다.
 */

export const acgFitnessVerdictReproducibility = z
  .object({
    model_version: z.string().min(1).describe('Pinned judge model id (e.g. claude-opus-4-8)'),
    prompt_hash: z.string().optional(),
    votes: z.number().int().min(1).optional(),
  })
  .describe('llm_judged verdict 재현 정보 (OBJ-07) — 누락 시 스키마 거부');

export const acgFitnessVerdictEntry = z
  .object({
    function_id: z.string().min(1).describe('FitnessFunction.id'),
    mode: z.enum(['llm_judged', 'executed']).describe('이 verdict가 대상으로 하는 평가 모드'),
    verdict: z.enum(['pass', 'fail']),
    violation_ids: z
      .array(z.string().min(1))
      .optional()
      .describe('verdict=fail 시 위반 식별자(없으면 function_id 단일 위반으로 처리)'),
    reproducibility: acgFitnessVerdictReproducibility.optional(),
    evidence_ref: z.string().min(1).optional().describe('executed: 재현 출처(로그/리포트 경로 등)'),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'llm_judged' && !value.reproducibility) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'llm_judged verdict requires reproducibility (model_version)',
        path: ['reproducibility'],
      });
    }
  })
  .describe('한 fitness function에 대한 에이전트 판정');

export const acgFitnessVerdictFile = z
  .object({
    schema_version: schemaVersion,
    kind: z.literal('acg.fitness-verdict.v1'),
    produced_by: acgProducedBy,
    produced_at: isoDateTime,
    verdicts: z.array(acgFitnessVerdictEntry).default([]),
  })
  .describe('ACG FitnessVerdict — 에이전트 주입형 fitness 판정 파일');

export type AcgFitnessVerdictEntry = z.infer<typeof acgFitnessVerdictEntry>;
export type AcgFitnessVerdictFile = z.infer<typeof acgFitnessVerdictFile>;
