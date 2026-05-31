/**
 * Charter projection (D8). The full charter lives in CLAUDE.md / skill bodies;
 * this is the *projection* re-injected every turn to fight drift — the prime
 * directive plus the currently active rules, kept short (progressive disclosure,
 * never the whole charter — tokens/noise).
 */

const PRIME_DIRECTIVE = [
  'DITTO prime directive:',
  '- Preserve the original request. Do not grow scope (IntentContract); do not shrink it or split one request into many work items without user approval.',
  '- One request = one work item. Every task leaves a work item and a completion contract.',
  '- Ask the user only what only the user can answer (QuestionGate); answer the rest from code/docs/web yourself.',
  '- Completion is gated by evidence, not by claim: every acceptance criterion must be closed with evidence before final_verdict=pass.',
  '- Internal checkpoint completion is not a final answer; the whole work item is the bar.',
].join('\n');

/**
 * Statement used when UserPromptSubmit auto-creates a draft work item before any
 * interview has happened. Single source of truth — both the writer (the hook)
 * and the reader (the placeholder advisory) reference this constant so the
 * detection cannot silently drift.
 */
export const PLACEHOLDER_AC_STATEMENT =
  'TBD — derive observable criteria during interview/planning';

const PLACEHOLDER_AC_ADVISORY =
  'acceptance criteria are placeholders — narrow them via /ditto:deep-interview before acting (IntentContract)';

/**
 * Stronger nudge surfaced when the placeholder situation coincides with an
 * execution-intent prompt (wi_v04intent_autopilot_entry AC-1). Points at the
 * concrete next command. Recommended but not enforced — the hook is advisory.
 */
const DEEP_INTERVIEW_DIRECTIVE =
  'Run /ditto:deep-interview now — placeholder acceptance criteria + execution intent detected. Recommended; may be skipped if the request is small or reversible (IntentContract entry).';

/**
 * Soft nudge attached to a question-shaped prompt that looks answerable from
 * code/docs (wi_v04intent_autopilot_entry AC-5, QuestionGate). Advisory only —
 * the LLM is not required to follow it, but the heuristic surfaces the option.
 */
const SELF_ANSWER_HINT =
  'self-answer from code/docs/web first before asking — this prompt looks answerable without user input (QuestionGate).';

export interface CharterContext {
  workItemId?: string;
  workItemTitle?: string;
  workItemStatus?: string;
  /** Concrete resume hint from a pending handoff / re_entry, if any. */
  pendingHandoff?: string;
  /** Advisory note when the active work item is ambiguous and must be resolved by the user. */
  advisory?: string;
  /**
   * True when every acceptance criterion of the active work item is the
   * auto-generated placeholder (wi_v04runtimewiring AC-3). Surfaces a one-line
   * advisory urging an interview before any action, so the IntentContract
   * outcome ("narrow the goal into observable criteria") gets a runtime nudge.
   */
  placeholderAcceptanceCriteria?: boolean;
  /**
   * True when the prompt is execution-intent AND the active work item still
   * has placeholder-only acceptance criteria (wi_v04intent_autopilot_entry AC-1).
   * Surfaces the concrete `/ditto:deep-interview` directive. The hook computes
   * the conjunction; charter rendering just attaches the directive line.
   */
  deepInterviewDirective?: boolean;
  /**
   * True when the prompt looks answerable from code/docs (QuestionGate
   * advisory, wi_v04intent_autopilot_entry AC-5). Advisory only; the hook
   * never blocks based on this flag.
   */
  selfAnswerHint?: boolean;
}

/** Build the additionalContext text injected on UserPromptSubmit. */
export function charterProjection(ctx: CharterContext = {}): string {
  const lines = [PRIME_DIRECTIVE];
  if (ctx.workItemId) {
    const head = `Active work item: ${ctx.workItemId}`;
    const detail = [
      ctx.workItemTitle ? `title="${ctx.workItemTitle}"` : null,
      ctx.workItemStatus ? `status=${ctx.workItemStatus}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    lines.push('', detail ? `${head} (${detail})` : head);
  }
  if (ctx.pendingHandoff) lines.push(`Pending handoff/re-entry: ${ctx.pendingHandoff}`);
  if (ctx.placeholderAcceptanceCriteria) lines.push('', `⚠ ${PLACEHOLDER_AC_ADVISORY}`);
  if (ctx.deepInterviewDirective) lines.push('', `▶ ${DEEP_INTERVIEW_DIRECTIVE}`);
  if (ctx.selfAnswerHint) lines.push('', `⚠ ${SELF_ANSWER_HINT}`);
  if (ctx.advisory) lines.push('', `⚠ ${ctx.advisory}`);
  return lines.join('\n');
}
