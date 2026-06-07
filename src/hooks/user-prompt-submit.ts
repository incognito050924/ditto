import { join } from 'node:path';
import { type CharterContext, PLACEHOLDER_AC_STATEMENT, charterProjection } from '~/core/charter';
import { localDir } from '~/core/ditto-paths';
import { atomicWriteText, ensureDir } from '~/core/fs';
import { HandoffStore } from '~/core/handoff-store';
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

  const pointed = await pointers.get(sessionId);
  if (pointed && (await items.exists(pointed))) {
    return { workItem: await items.get(pointed), action: 'loaded' };
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

  // Active handoff 자동 로드 (wi_260605wf3): 파일명을 명시하지 않아도 본문을
  // 컨텍스트로 주입한 뒤 archive 로 옮긴다 → 정확히 1회 픽업, active 누적 0.
  // fail-open: handoff 읽기/이동 실패가 프롬프트 훅을 막지 않는다.
  try {
    const hstore = new HandoffStore(input.repoRoot);
    const active = await hstore.listActive();
    if (active.length > 0) {
      ctx.handoffBodies = active.map((a) => a.body);
      await hstore.consume();
    }
  } catch {
    // handoff 자동 로드 실패는 무시 (관측적, non-blocking)
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
