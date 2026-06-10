import { z } from 'zod';

/**
 * E2E 실패 판정 원장 레코드 (wi_260610p9h ac-12, spec §8).
 *
 * An e2e failure may NOT drive a feature-code fix until the user has classified
 * it. The classification is the user's verdict — the agent only proposes — so
 * `confirmed_by_user` is the literal `true`: an unconfirmed verdict is not a
 * weaker record, it is unrepresentable. Ledger lives at
 * `.ditto/local/work-items/<wi>/e2e-verdicts.jsonl` (append-only).
 */

export const e2eFailureClassification = z
  .enum(['기능', '스크립트', '환경', 'flaky'])
  .describe(
    'User verdict on an e2e failure: 기능 결함 | 스크립트 결함 | 환경·데이터 | flaky (spec §8 4분류)',
  );

export type E2eFailureClassification = z.infer<typeof e2eFailureClassification>;

export const e2eFailureVerdict = z
  .object({
    journey_id: z.string().min(1).describe('Journey the failing test maps back to (jrn-…)'),
    case_name: z.string().min(1).describe('Case name from the test title `<journey-id> · <case>`'),
    classification: e2eFailureClassification,
    confirmed_by_user: z
      .literal(true)
      .describe('Literal true — a verdict not confirmed by the user cannot be recorded'),
    basis: z.string().min(1).describe('Why this classification (evidence the user judged on)'),
    decided_at: z.string().min(1).describe('ISO timestamp of the user verdict'),
  })
  .describe('One user-confirmed e2e failure verdict (e2e-verdicts.jsonl line)');

export type E2eFailureVerdict = z.infer<typeof e2eFailureVerdict>;
