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

export interface CharterContext {
  workItemId?: string;
  workItemTitle?: string;
  workItemStatus?: string;
  /** Concrete resume hint from a pending handoff / re_entry, if any. */
  pendingHandoff?: string;
  /** Advisory note when the active work item is ambiguous and must be resolved by the user. */
  advisory?: string;
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
  if (ctx.advisory) lines.push('', `⚠ ${ctx.advisory}`);
  return lines.join('\n');
}
