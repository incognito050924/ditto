import { join } from 'node:path';
import { type CharterContext, charterProjection } from '~/core/charter';
import { localDir } from '~/core/ditto-paths';
import { atomicWriteText, ensureDir } from '~/core/fs';
import { IntentStore } from '~/core/intent-store';
import { SessionPointerStore } from '~/core/session-pointer';
import type { WorkItem } from '~/core/work-item-store';
import type { HookHandler, HookInput } from '../runtime';
// The prompt-classification / active-work-item heuristics are the legacy
// module's exported pure(ish) helpers — they encode subtle carve-outs (Korean
// particles, no-auto-pick / explicit-resume invariants) that must not drift, so
// they are imported rather than re-derived.
import {
  allAcceptancePlaceholders,
  classifyPromptAdvisory,
  hasHeavyRiskSignal,
  legacyHandoffLeftoverWarning,
  looksCodebaseAnswerable,
  resolveActiveWorkItem,
} from '../user-prompt-submit';

/**
 * UserPromptSubmit hook — rebuilt thin shell (increment 3). Advisory only:
 * never blocks (exit 0 + additionalContext). Preserved behavior: charter
 * projection injection on every prompt (the injected text content is owned by
 * `~/core/charter` and unchanged here), single-active work-item resolution
 * (no-auto-pick), the deep-interview directive (placeholder-AC or risk signal ∧
 * execution intent), the self-answer hint, the classification log line, and the
 * session-pointer stale-GC tick. The handoff stale-sweep that used to run here
 * was removed without replacement (wi_260722g7h): hidden-ref handoff consume deletes
 * immediately, so there is no stale-active handoff set to sweep; only the
 * transitional legacy-leftover 1-line warning remains.
 */

/** Heavy signal on a finalized intent: unresolved unknowns. Fail-open. */
async function intentHasRiskSignal(repoRoot: string, workItemId: string): Promise<boolean> {
  try {
    const intents = new IntentStore(repoRoot);
    if (!(await intents.exists(workItemId))) return false;
    return (await intents.get(workItemId)).unknowns.length > 0;
  } catch {
    return false;
  }
}

/** re_entry command hint only — no handoff body is ever auto-injected. */
function pendingHandoffHint(item: WorkItem): string | undefined {
  return item.re_entry?.command;
}

async function logClassification(repoRoot: string, entry: Record<string, unknown>): Promise<void> {
  const dir = localDir(repoRoot, 'logs');
  await ensureDir(dir);
  const path = join(dir, 'user-prompt.jsonl');
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : '';
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  await atomicWriteText(path, `${prefix}${JSON.stringify(entry)}\n`);
}

function contextOutput(text: string) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
    }),
  };
}

export const userPromptSubmitHandler: HookHandler = async (input: HookInput) => {
  const raw = (input.raw ?? {}) as Record<string, unknown>;
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
  const classification = classifyPromptAdvisory(prompt);

  // Without a session id we cannot track the single-active pointer; still inject charter.
  if (!sessionId) {
    return contextOutput(charterProjection());
  }

  const resolved = await resolveActiveWorkItem(input.repoRoot, sessionId, prompt);

  await logClassification(input.repoRoot, {
    ts: new Date().toISOString(),
    session_id: sessionId,
    classification,
    action: resolved.action,
    work_item_id: resolved.workItem?.id ?? null,
  });

  const ctx: CharterContext = {};

  // Handoff bodies are not auto-injected; the once-per-prompt tick only runs
  // the session-pointer stale GC (the handoff sweep is gone — consume on the
  // handoff ref deletes immediately; no network call may enter this path).
  // Fail-open: a GC error must not break the prompt hook.
  try {
    await new SessionPointerStore(input.repoRoot).sweepStale();
  } catch {
    // sweep failure is observational, non-blocking
  }

  const item = resolved.workItem;
  if (item) {
    ctx.workItemId = item.id;
    ctx.workItemTitle = item.title;
    ctx.workItemStatus = item.status;
    const handoff = pendingHandoffHint(item);
    if (handoff) ctx.pendingHandoff = handoff;
    const placeholderOnly = allAcceptancePlaceholders(item);
    if (placeholderOnly) ctx.placeholderAcceptanceCriteria = true;
    // deep-interview directive: execution intent ∧ (placeholder-only AC OR a
    // heavy risk signal on the work item / its finalized intent).
    const riskSignal =
      hasHeavyRiskSignal(item) || (await intentHasRiskSignal(input.repoRoot, item.id));
    if ((placeholderOnly || riskSignal) && classification === 'execution')
      ctx.deepInterviewDirective = true;
  }
  // QuestionGate advisory: question-shaped + code-locatable surface mention →
  // hint to self-answer first. Independent of work item state.
  if (classification === 'question' && looksCodebaseAnswerable(prompt)) {
    ctx.selfAnswerHint = true;
  }
  if (resolved.advisory) ctx.advisory = resolved.advisory;
  // Empty state: inject the work-item guide (no auto-create, no block).
  if (resolved.action === 'guide') ctx.workItemGuide = true;

  // Transitional 1-line cutover warning for old file-tier handoff leftovers.
  const legacyWarning = await legacyHandoffLeftoverWarning(input.repoRoot);

  return contextOutput(charterProjection(ctx) + (legacyWarning ? `\n\n${legacyWarning}` : ''));
};
