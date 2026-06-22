import { z } from 'zod';
import { selfAnswerAttempt } from '~/schemas/question-gate';

/**
 * Presentation-contract gate (wi_260622ph8). A deep-interview question may only be
 * ASKED of the user once it carries the comprehensible, decision-sufficient context
 * the user needs to answer: a plain-language why-we-ask + what-the-answer-decides
 * (`user_explanation`) on top of the value statement (`why_matters`). The
 * question-generator emits this context; the driver runs THIS check on each gate-
 * selected candidate BEFORE presenting it (Q3: "generator emit + gate 하드검사") —
 * an under-contextualized candidate is rejected (regenerate), never shown.
 *
 * This checks structural PRESENCE of the contract fields, not content quality — the
 * LLM gate already scores quality; this guarantees the user-facing context exists at
 * all, so the success proxy ("structural contract satisfied", Q1) is enforceable.
 *
 * `background` / `grounding` are the progressive-disclosure tiers (Q2: "always plain
 * + progressive disclosure") — optional by design, expanded on demand, so they are
 * NOT hard-required here.
 */
export const questionContextCandidate = z
  .object({
    text: z.string().min(1),
    why_matters: z.string().min(1),
    user_explanation: z.string().optional(),
    background: z.string().optional(),
    grounding: z.string().optional(),
    self_answer_attempts: z.array(selfAnswerAttempt).optional(),
  })
  .describe('A gate-selected question candidate checked against the presentation contract');

export type QuestionContextCandidate = z.infer<typeof questionContextCandidate>;

export interface ContextViolation {
  field: string;
  reason: string;
}

export interface QuestionContextVerdict {
  ok: boolean;
  violations: ContextViolation[];
}

const isBlank = (s: string | undefined): boolean => s === undefined || s.trim().length === 0;

/**
 * Returns `{ ok, violations }`. `ok` is true only when every required context field
 * is present and non-blank. Pure and deterministic — the unit of evidence for ac-2.
 */
export function validateQuestionContext(
  candidate: QuestionContextCandidate,
): QuestionContextVerdict {
  const violations: ContextViolation[] = [];
  if (isBlank(candidate.user_explanation)) {
    violations.push({
      field: 'user_explanation',
      reason:
        'a plain-language why-we-ask + what-the-answer-decides (user language, no raw code/jargon) is required before asking the user',
    });
  }
  if (isBlank(candidate.why_matters)) {
    violations.push({
      field: 'why_matters',
      reason: 'the value of the answer (what it decides) must be stated',
    });
  }
  return { ok: violations.length === 0, violations };
}
