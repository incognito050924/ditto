import {
  type QuestionRound,
  type QuestionRoundPayload,
  questionRound,
  questionRoundPayload,
} from '~/schemas/question-round';
import { WorkItemStore } from './work-item-store';

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
