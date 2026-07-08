import { join } from 'node:path';
import { type CharterContext, PLACEHOLDER_AC_STATEMENT, charterProjection } from '~/core/charter';
import { localDir } from '~/core/ditto-paths';
import { atomicWriteText, ensureDir } from '~/core/fs';
import { HandoffStore } from '~/core/handoff-store';
import { IntentStore } from '~/core/intent-store';
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
  // Korean execution-intent first: an explicit order ("…해줘", "구현", "수정"…)
  // must stay 'execution' even when it ends with a question-ish particle, so the
  // deep-interview directive still fires. (Korean is unaffected by toLowerCase.)
  if (/(해\s*줘|해\s*주세요|해라|하라|구현|수정|추가|만들어|고쳐|바꿔|적용|삭제|제거)/.test(t)) {
    return 'execution';
  }
  // Korean question: terminal interrogative particle OR an interrogative word.
  if (
    /(까|나요|는가|인가|니|냐|을까|ㄹ까|ㄴ가)\s*[?？]?\s*$/.test(t) ||
    /(무엇|뭐|왜|어떻게|어떤|언제|어디|누가|누구|어느|몇)/.test(t)
  ) {
    return 'question';
  }
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
  // Korean code-surface vocabulary (V4): `\b` word boundaries do not apply to
  // Hangul, so these match as substrings. Mirrors the English set so a Korean
  // question like "이 함수 왜 실패해?" / "테스트 로그 어디 있어?" gets the same
  // self-answer hint instead of silently missing it.
  /파일|경로|디렉터리|디렉토리|함수|메서드|메소드|오류|에러|예외|버그|테스트|로그|클래스|모듈|스키마|코드|커밋|타입/,
];

export function looksCodebaseAnswerable(prompt: string): boolean {
  return CODEBASE_ANSWERABLE_PATTERNS.some((re) => re.test(prompt));
}

/** Significant tokens of a string for duplicate-search overlap (len ≥ 3). */
function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9가-힣]+/)
      .filter((t) => t.length >= 3),
  );
}

/**
 * Rank open work items whose title shares tokens with the prompt (ac-4). Returns
 * the overlapping items best-first; empty when nothing meaningfully overlaps.
 * Title-only (the list summary carries no goal); cheap and advisory.
 */
export function duplicateSearch(
  prompt: string,
  open: ReadonlyArray<{ id: string; title: string }>,
): Array<{ id: string; title: string; overlap: number }> {
  const promptTokens = tokens(prompt);
  if (promptTokens.size === 0) return [];
  return open
    .map((s) => {
      let overlap = 0;
      for (const t of tokens(s.title)) if (promptTokens.has(t)) overlap++;
      return { id: s.id, title: s.title, overlap };
    })
    .filter((m) => m.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);
}

/**
 * An explicit work-item id the user named in the prompt (e.g. "resume wi_…"),
 * lowercased, or undefined. This is the EXPLICIT resume signal the ask-advisory
 * tells the user to give; binding on it is a user action, NOT an arbitrary
 * auto-pick, so the single-active no-auto-pick invariant (plan §3 F3) holds.
 */
/**
 * A resume-intent keyword that, alongside a wi_ id, marks the mention as an
 * explicit resume command rather than an incidental reference. English verbs are
 * word-bounded; Korean markers are matched as substrings (no word boundaries).
 */
const RESUME_KEYWORD = /\b(resume|reopen|switch to|work on)\b|이어서|이어받|재개/i;

export function explicitWorkItemRef(prompt: string): string | undefined {
  const m = prompt.match(/\bwi_[a-z0-9]{8,}\b/i);
  if (!m) return undefined;
  const id = m[0].toLowerCase();
  // A bare wi_ token buried in prose is an INCIDENTAL mention (a quoted id, a
  // "similar to wi_X" comparison, or an injected tool-result), NOT a resume
  // command. Binding the session pointer on it falsely adopts an unrelated work
  // item and trips its Stop gate (gotcha wi_260627jor). Count it as a resume
  // signal only when the id LEADS the prompt (the user named it as the whole or
  // leading instruction) or a resume-intent keyword co-occurs.
  const leads = prompt.trimStart().toLowerCase().startsWith(id);
  return leads || RESUME_KEYWORD.test(prompt) ? id : undefined;
}

export interface ActiveResolution {
  workItem?: WorkItem;
  /** Set when the active work item is ambiguous and the user must choose (no arbitrary pick). */
  advisory?: string;
  action: 'loaded' | 'ask' | 'guide';
}

/**
 * Resolve the single active work item for a session (plan §3 F3).
 *  - pointer present → load it (pointer wins even if other drafts exist)
 *  - pointer absent + open work items exist → ASK which to resume (never auto-pick)
 *  - pointer absent + no open work items → GUIDE only (no auto-create, no pointer):
 *    the agent makes the 1st-pass WI judgment; creation is manual + confirmed.
 */
export async function resolveActiveWorkItem(
  repoRoot: string,
  sessionId: string,
  prompt: string,
): Promise<ActiveResolution> {
  const items = new WorkItemStore(repoRoot);
  const pointers = new SessionPointerStore(repoRoot);

  // A session is ACTIVELY bound when its pointer is set AND still resolves to an
  // existing work item. A stale pointer (its work item was deleted) is not active.
  const pointed = await pointers.get(sessionId);
  const activeWorkItem =
    pointed !== null && (await items.exists(pointed)) ? await items.get(pointed) : undefined;

  // Explicit resume (ac-6): the user named an existing work item id in the
  // prompt. Bind the session pointer to it — the runtime SessionPointerStore.set()
  // call — so evidence (post-tool-use command/changed-file log) and leases
  // (pre-tool-use scope enforcement) attribute to THIS work item. Without this
  // wiring the pointer was only ever set in tests, so a real session never bound
  // and post-tool-use recorded no evidence. Explicit signal only, never an
  // arbitrary pick.
  //
  // ac-1 (wi_260625x74): bind ONLY when the session has no active pointer (first
  // resume). An already-bound session is NOT rebound by a bare wi_ mention of a
  // different work item — silent rebinding would re-route evidence/leases away
  // from the active work item. The active binding wins.
  const explicit = explicitWorkItemRef(prompt);
  if (!activeWorkItem && explicit && (await items.exists(explicit))) {
    await pointers.set(sessionId, explicit);
    return { workItem: await items.get(explicit), action: 'loaded' };
  }

  if (activeWorkItem) {
    return { workItem: activeWorkItem, action: 'loaded' };
  }

  const open = (await items.list()).filter((s) => NON_TERMINAL.includes(s.status));
  if (open.length > 0) {
    const ids = open.map((s) => s.id).join(', ');
    // Execution-intent + no active pointer (ac-4): surface a duplicate-search over
    // open work items by title token overlap so the user reuses an existing WI
    // instead of opening a near-duplicate, and nudge WI creation when nothing
    // matches. Advisory only — the caller stays exit 0 and never blocks.
    const matches =
      classifyPromptAdvisory(prompt) === 'execution' ? duplicateSearch(prompt, open) : [];
    const dupLine =
      matches.length > 0
        ? ` Possible duplicates by title overlap: ${matches
            .map((m) => `${m.id} ("${m.title}")`)
            .join('; ')}.`
        : '';
    return {
      action: 'ask',
      advisory: `No active work item pointer for this session and ${open.length} open work item(s) exist (${ids}).${dupLine} Resume one explicitly, or create a NEW work item before acting — not picking arbitrarily.`,
    };
  }

  // Empty state (no active pointer + no open work items): GUIDE only. The hook
  // no longer auto-creates a draft. The agent makes the 1st-pass WI judgment;
  // if a work item is warranted it is created manually after confirming intent
  // (`ditto work start`). No create, no pointer set, exit 0.
  return { action: 'guide' };
}

/** True iff every acceptance criterion of the work item is the placeholder. */
export function allAcceptancePlaceholders(item: WorkItem): boolean {
  if (item.acceptance_criteria.length === 0) return false;
  return item.acceptance_criteria.every((ac) => ac.statement === PLACEHOLDER_AC_STATEMENT);
}

/**
 * ac-3 B: heavy-path risk signal carried by the work item itself — any
 * `declared_risk` flag (gates.ts RiskAxes vocabulary) or a `work promote` marker.
 * This is what keeps the deep-interview nudge alive AFTER `set-criteria` replaced
 * the placeholder (so `allAcceptancePlaceholders` is false): heavy detection is
 * risk-driven, not placeholder-string driven.
 */
export function hasHeavyRiskSignal(item: WorkItem): boolean {
  const r = item.declared_risk;
  const declared = !!r && (r.non_local === true || r.irreversible === true || r.unaudited === true);
  return declared || item.promoted_to_heavy === true;
}

/**
 * ac-3 B (intent side): a finalized intent.json with unresolved unknowns is a
 * heavy signal too. (intent.json does NOT persist risk flags — gates.ts:418-420
 * — so `unknowns` is the only re-evaluable signal on it.) Fail-open: a missing or
 * malformed intent never breaks the advisory hook.
 */
async function intentHasRiskSignal(repoRoot: string, workItemId: string): Promise<boolean> {
  try {
    const intents = new IntentStore(repoRoot);
    if (!(await intents.exists(workItemId))) return false;
    return (await intents.get(workItemId)).unknowns.length > 0;
  } catch {
    return false;
  }
}

// re_entry 명령만 보조 힌트로 남긴다. handoff 본문은 더 이상 "see {path}" 로
// 가리키지 않고, 아래 handler 가 .ditto/local/handoff/ 에서 본문을 자동으로 주입한다
// (wi_260605wf3: 파일명 명시 없는 자동 읽기).
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

  // Handoff bodies are NO LONGER auto-injected (wi_260708700). Auto-load
  // (wi_260605wf3) had no efficacy in practice and dumped the verbatim body into
  // context on every resume turn. Handoffs now stay active for MANUAL load (a
  // follow-up read mechanism); the once-per-prompt tick only runs GC:
  //  - sweepStaleActive (wi_2606289nt): archive a handoff no one picked up past
  //    the retention limit, so it can never linger forever.
  //  - SessionPointerStore.sweepStale (WS-HND-T3, wi_260706kdx): retire stale
  //    session pointers so a reused session id never re-binds to a dead work item.
  // fail-open: a GC error must not break the prompt hook.
  try {
    await new HandoffStore(input.repoRoot).sweepStaleActive();
    await new SessionPointerStore(input.repoRoot).sweepStale();
  } catch {
    // sweep 실패는 무시 (관측적, non-blocking)
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
    // deep-interview directive: fire on execution intent when EITHER the AC are
    // still placeholder-only OR the work carries a heavy risk signal (ac-3 B).
    // The risk arm is what stops `set-criteria` (which clears placeholderOnly)
    // from silently dropping the heavy nudge for high-risk work. The execution
    // conjunction is preserved (§2#3: do not auto-promote small/question prompts).
    const riskSignal =
      hasHeavyRiskSignal(item) || (await intentHasRiskSignal(input.repoRoot, item.id));
    if ((placeholderOnly || riskSignal) && classification === 'execution')
      ctx.deepInterviewDirective = true;
  }
  // §AC-5 QuestionGate advisory: question-shaped + code-locatable surface
  // mention → hint to self-answer first. Independent of work item state.
  if (classification === 'question' && looksCodebaseAnswerable(prompt)) {
    ctx.selfAnswerHint = true;
  }
  if (resolved.advisory) ctx.advisory = resolved.advisory;
  // Empty-state: inject the work-item guide (1st-pass judgment + creation-intent
  // confirmation + how-to-create). Guidance only — no auto-create, no block.
  if (resolved.action === 'guide') ctx.workItemGuide = true;

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
