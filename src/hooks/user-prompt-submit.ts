import { join } from 'node:path';
import { type CharterContext, PLACEHOLDER_AC_STATEMENT, charterProjection } from '~/core/charter';
import { atomicWriteText, ensureDir } from '~/core/fs';
import { SessionPointerStore } from '~/core/session-pointer';
import { type WorkItem, WorkItemStore } from '~/core/work-item-store';
import type { HookHandler, HookInput } from './runtime';

const NON_TERMINAL: ReadonlyArray<WorkItem['status']> = [
  'draft',
  'in_progress',
  'blocked',
  'partial',
  'unverified',
];

/** Advisory-only classification (D2: a hint, not a keyword gate; real judgment is the skill's). */
export function classifyPromptAdvisory(prompt: string): 'question' | 'execution' {
  const t = prompt.trim().toLowerCase();
  if (t.endsWith('?') || /^(what|why|how|when|where|who|which|is|are|does|can|should)\b/.test(t)) {
    return 'question';
  }
  return 'execution';
}

/**
 * QuestionGate advisory heuristic (§AC-5, wi_v04intent_autopilot_entry). True
 * when the prompt is question-shaped AND mentions concrete code-locatable
 * surface (file/path/function/error/test/log). Conservative on purpose:
 * single-word boundaries only, and the result is advisory — the LLM is not
 * required to follow it. Aligns with plan §11 "advisory only, no keyword gate".
 */
const CODEBASE_ANSWERABLE_PATTERNS = [
  /\bfile\b/i,
  /\bfiles\b/i,
  /\bpath\b/i,
  /\bfunction\b/i,
  /\bmethod\b/i,
  /\berror\b/i,
  /\bexception\b/i,
  /\btest\b/i,
  /\btests\b/i,
  /\blog\b/i,
  /\blogs\b/i,
  /\bclass\b/i,
  /\bmodule\b/i,
  /\bschema\b/i,
  /\.(ts|js|tsx|jsx|json|md|sh|py)\b/i,
];

export function looksCodebaseAnswerable(prompt: string): boolean {
  return CODEBASE_ANSWERABLE_PATTERNS.some((re) => re.test(prompt));
}

export interface ActiveResolution {
  workItem?: WorkItem;
  /** Set when the active work item is ambiguous and the user must choose (no arbitrary pick). */
  advisory?: string;
  action: 'loaded' | 'created' | 'ask';
}

/**
 * Resolve the single active work item for a session (plan §3 F3).
 *  - pointer present → load it (pointer wins even if other drafts exist)
 *  - pointer absent + open work items exist → ASK which to resume (never auto-pick)
 *  - pointer absent + no open work items → create a draft and set the pointer
 */
export async function resolveActiveWorkItem(
  repoRoot: string,
  sessionId: string,
  prompt: string,
  now: Date = new Date(),
): Promise<ActiveResolution> {
  const items = new WorkItemStore(repoRoot);
  const pointers = new SessionPointerStore(repoRoot);

  const pointed = await pointers.get(sessionId);
  if (pointed && (await items.exists(pointed))) {
    return { workItem: await items.get(pointed), action: 'loaded' };
  }

  const open = (await items.list()).filter((s) => NON_TERMINAL.includes(s.status));
  if (open.length > 0) {
    const ids = open.map((s) => s.id).join(', ');
    return {
      action: 'ask',
      advisory: `No active work item pointer for this session and ${open.length} open work item(s) exist (${ids}). Resume one explicitly or start a new work item — not picking arbitrarily.`,
    };
  }

  const title = prompt.trim().slice(0, 80) || 'untitled request';
  const created = await items.create(
    {
      title,
      source_request: prompt || title,
      goal: prompt || title,
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: PLACEHOLDER_AC_STATEMENT,
          verdict: 'unverified',
          evidence: [],
        },
      ],
    },
    now,
  );
  await pointers.set(sessionId, created.id, now);
  return { workItem: created, action: 'created' };
}

/** True iff every acceptance criterion of the work item is the placeholder. */
export function allAcceptancePlaceholders(item: WorkItem): boolean {
  if (item.acceptance_criteria.length === 0) return false;
  return item.acceptance_criteria.every((ac) => ac.statement === PLACEHOLDER_AC_STATEMENT);
}

function pendingHandoffHint(item: WorkItem): string | undefined {
  if (item.re_entry?.command) return item.re_entry.command;
  if (item.handoff_path) return `see ${item.handoff_path}`;
  return undefined;
}

async function logClassification(repoRoot: string, entry: Record<string, unknown>): Promise<void> {
  const dir = join(repoRoot, '.ditto', 'logs');
  await ensureDir(dir);
  const path = join(dir, 'user-prompt.jsonl');
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : '';
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  await atomicWriteText(path, `${prefix}${JSON.stringify(entry)}\n`);
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
  const item = resolved.workItem;
  if (item) {
    ctx.workItemId = item.id;
    ctx.workItemTitle = item.title;
    ctx.workItemStatus = item.status;
    const handoff = pendingHandoffHint(item);
    if (handoff) ctx.pendingHandoff = handoff;
    const placeholderOnly = allAcceptancePlaceholders(item);
    if (placeholderOnly) ctx.placeholderAcceptanceCriteria = true;
    // §AC-1 deep-interview directive: only when BOTH conditions hold —
    // placeholder-only AC AND execution-intent prompt. The conjunction guards
    // against the §2#3 non-goal of auto-promoting small requests into a heavy
    // interview workflow.
    if (placeholderOnly && classification === 'execution') ctx.deepInterviewDirective = true;
  }
  // §AC-5 QuestionGate advisory: question-shaped + code-locatable surface
  // mention → hint to self-answer first. Independent of work item state.
  if (classification === 'question' && looksCodebaseAnswerable(prompt)) {
    ctx.selfAnswerHint = true;
  }
  if (resolved.advisory) ctx.advisory = resolved.advisory;

  // UserPromptSubmit is advisory: never blocks (exit 0 + additionalContext).
  return contextOutput(charterProjection(ctx));
};

function contextOutput(text: string) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
    }),
  };
}
