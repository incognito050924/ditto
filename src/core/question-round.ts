import {
  type QuestionRound,
  type QuestionRoundPayload,
  type ScoredQuestion,
  questionRound,
  questionRoundPayload,
} from '~/schemas/question-round';
import { validateQuestionContext } from './question-context';
import { WorkItemStore } from './work-item-store';

/**
 * Presentation-contract gate for a persisted round's user-reaching questions
 * (wi_260713 impl-ac1-prism ac-1). Enforces the SAME contract the deep-interview
 * pre-ask gate applies via `validateQuestionContext`, but on the prism-equivalent
 * WRITE path (`PrismStore.appendValueRound`), so a text-carrying prism round can
 * never be persisted under-contextualized. (Not wired into `recordRound`: that is
 * the deep-interview driver's score-trail sink whose selected entries legitimately
 * carry only text+scores as measurement instrumentation.)
 *
 * Surface is limited to each SELECTED question's user face (text + user_explanation):
 * a missing `user_explanation` or an un-glossed internal identifier leaked in
 * text/user_explanation rejects the round BEFORE persist. `why_matters` and the raw
 * `all_scored` score trail are NOT part of this user-reaching surface, so only the
 * `user_explanation` and `unexplained_identifier` violations are enforced here.
 *
 * ac-7 decision (no whitelist change): the newly-landed doc/section-ref leak detection
 * (§N / ADR-YYYYMMDD-slug) surfaces as an `unexplained_identifier` violation, which is ALREADY
 * whitelisted here — so it reaches the prism selected face with no change. Conversely the new
 * `recommended_answer` blank-check violation is DELIBERATELY left out: prism carries no
 * recommended_answer field, so validateQuestionContext always reports it blank; filtering it
 * out keeps a prism round (which legitimately has no recommended_answer) from being rejected.
 */
const ROUND_SURFACE_FIELDS = new Set(['user_explanation', 'unexplained_identifier']);

// wi_260714aaq (#29): `opaqueVocab` = the caller-resolved glossary forbidden_abbreviations,
// unioned with the detector's hardcoded floor. The hardcoded floor is enforced here
// UNCONDITIONALLY (validateQuestionContext applies it even for the default []), so the prism
// selected face always rejects floor opaque-vocab. The glossary half is now resolved by the
// caller (PrismStore.appendValueRound, which holds repoRoot) via `loadGlossaryVocab` and
// passed in here — mirroring interview-driver.ts recordTurn.
export function assertSelectedPresentationContract(
  selected: readonly ScoredQuestion[],
  opaqueVocab: readonly string[] = [],
): void {
  const lines: string[] = [];
  selected.forEach((q, i) => {
    const verdict = validateQuestionContext(
      {
        text: q.text,
        // why_matters is out of the user-reaching surface here; pass it through when
        // present, but its absence is filtered out below (not an ac-1 violation).
        why_matters: q.why_matters ?? '',
        user_explanation: q.user_explanation,
      },
      opaqueVocab,
    );
    for (const v of verdict.violations) {
      if (ROUND_SURFACE_FIELDS.has(v.field)) {
        lines.push(`  - ${i + 1}번째 질문 "${q.text.slice(0, 80)}": ${v.reason}`);
      }
    }
  });
  if (lines.length > 0) {
    throw new Error(
      `이번 질문들을 저장하지 못했어요 — 사용자에게 보여줄 질문이 갖춰야 할 안내(왜 묻는지·쉬운 말 설명)를 아직 갖추지 못했어요:\n${lines.join('\n')}`,
    );
  }
}

/**
 * question-round sink (증분 3 — 다중-에이전트 질문 워크플로의 점수 영속 sink).
 * Extracted from the retired tech-spec surface (wi_260707oi1); the persistence
 * plumbing lives in WorkItemStore (`appendQuestionRoundLine` / `readQuestionRounds`)
 * and `ditto doctor intent-quality` reads the trail as the question-VALUE signal.
 */

/** The driver records one gate round's scores; ts + work_item_id are stamped on persist. */
export const recordRoundPayload = questionRoundPayload;
export type RecordRoundPayload = QuestionRoundPayload;

export interface RecordRoundInput {
  workItemId: string;
  payload: RecordRoundPayload;
  now?: Date;
}

/**
 * Append one question-round's gate scores to question-rounds.jsonl (the durable
 * score trail). Rounds run during the interview, before finalize.
 * `ditto doctor intent-quality` reads the trail as the question-VALUE signal.
 * Requires the work item to exist.
 */
export async function recordRound(
  repoRoot: string,
  input: RecordRoundInput,
): Promise<QuestionRound> {
  const store = new WorkItemStore(repoRoot);
  if (!(await store.exists(input.workItemId))) {
    throw new Error(`work item ${input.workItemId} not found`);
  }
  const record: QuestionRound = questionRound.parse({
    ts: (input.now ?? new Date()).toISOString(),
    work_item_id: input.workItemId,
    ...input.payload,
  });
  await store.appendQuestionRoundLine(input.workItemId, JSON.stringify(record));
  return record;
}
