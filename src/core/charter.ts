/**
 * Charter projection (D8). The full charter lives in CLAUDE.md / skill bodies;
 * this is the *projection* re-injected every turn to fight drift — the prime
 * directive plus the currently active rules, kept short (progressive disclosure,
 * never the whole charter — tokens/noise).
 */

/**
 * One executable charter self-check — a probing question the agent must answer
 * for every change, exported as DATA (id + question + provenance) so a receiving
 * gate can inject/enforce it rather than paraphrase it (single SoT, no drift).
 */
export interface CharterSelfCheck {
  /** Stable id (kebab) — keeps the lineage to its origin (e.g. a routed-out far-field category). */
  id: string;
  /** The probing question, verbatim — the enforcement surface. */
  question: string;
  /** Where the check came from and why it lives here. */
  origin: string;
}

/**
 * minimal-increment, routed OUT of the far-field taxonomy floor (wi_260706n4w
 * ac-2): it probes design-META quality (right-sized increment), not a far RISK,
 * so it belongs to the charter — the projection re-injected every turn — instead
 * of the pre-mortem sweep. The far-field completeness ledger keeps the removal
 * auditable (FAR_FIELD_ROUTED_OUT in coverage-taxonomy — ac-3, no silent
 * narrowing); this constant is the live receiving end. The question text is the
 * single SoT: the taxonomy-side ledger record references it verbatim.
 */
export const MINIMAL_INCREMENT_SELF_CHECK: CharterSelfCheck = {
  id: 'minimal-increment',
  question:
    '이게 의도를 달성하는 가장 작고 명료한 증분인가? 추상화가 실제 복잡도에 비례하나 — 요청되지 않은 기능·설정·확장성이나 단일 사용·얕은 추상화로 과하지 않고(흔한 실패), 거꾸로 새로 생기는 중복을 방치해 모자라지도 않나? 변경한 모든 줄이 요청과 연결되고, 무관한 리팩터·포맷 정리가 섞이지 않았나?',
  origin:
    'far-field taxonomy floor → charter self-check (wi_260706n4w — 설계-메타 품질이라 먼 위험 sweep이 아니라 매 턴 재주입되는 charter가 집행한다)',
};

/** All executable charter self-checks (projected every turn, below). */
export const CHARTER_SELF_CHECKS: readonly CharterSelfCheck[] = [MINIMAL_INCREMENT_SELF_CHECK];

// Compressed to tight anchors (wi_260708700): re-injected EVERY turn, so each
// rule is one compact line — enough to re-anchor against drift, without the
// verbose command-lists/how-to that already live in CLAUDE.md/WORKFLOW/skills.
// The minimal-increment self-check is projected VERBATIM (it is a cross-
// referenced SoT — see MINIMAL_INCREMENT_SELF_CHECK) and stays uncompressed.
const PRIME_DIRECTIVE = [
  'DITTO prime directive:',
  '- Preserve the original request (IntentContract): do not grow scope, nor shrink/split it without user approval.',
  '- Every codebase change runs under a work item via TWO standard paths only — heavy (/ditto:deep-interview → autopilot) or light (ditto work set-criteria → verify → done). Ad-hoc/console-TDD editing outside a work item is a FORBIDDEN third path; TDD is HOW you implement inside a path, not a substitute.',
  '- YOU judge whether a request needs a work item, and which path (Route by weight, advisory): small/reversible → light; ambiguous/irreversible/multi-surface or declared risk → heavy. The hook never auto-creates one; when warranted, register it YOURSELF: `ditto work start`.',
  '- Ask only what only the user can answer (QuestionGate); self-answer the rest from code/docs/web.',
  '- Completion is evidence-gated: every acceptance criterion closed with evidence before final_verdict=pass; the whole work item is the bar, not a checkpoint.',
  // Executable self-check routed into the charter (wi_260706n4w): projected
  // verbatim from CHARTER_SELF_CHECKS so the check that left the far-field sweep
  // stays enforced every turn, not archived as documentation.
  ...CHARTER_SELF_CHECKS.map((c) => `- Self-check (${c.id}): ${c.question}`),
].join('\n');

/**
 * Statement used for placeholder acceptance criteria on a work item created
 * before any interview has happened (e.g. via `ditto work start` or manual
 * create). Single source of truth — both the writer and the reader (the
 * placeholder advisory) reference this constant so the detection cannot
 * silently drift. NOTE: UserPromptSubmit no longer auto-creates work items.
 */
export const PLACEHOLDER_AC_STATEMENT =
  'TBD — derive observable criteria during interview/planning';

/**
 * Advisory the hook injects in the empty-state (no active pointer + no open
 * work items). Guidance only — the hook itself does NOT create a work item and
 * does NOT block. It restates the 1st-pass judgment so the AGENT decides and,
 * when warranted, registers the work item itself by running the command.
 */
const WORK_ITEM_GUIDE_ADVISORY =
  'No active work item. Make the 1st-pass judgment yourself: if this request produces an artifact or makes an irreversible codebase change, it should become a work item (simple tasks, handoff, git ops are exceptions). If so, confirm the intent with the user, then register it YOURSELF by running `ditto work start "<goal>" --request "<verbatim request>"` — you create it automatically, the user does not type the command. Otherwise just proceed as normal work.';

const PLACEHOLDER_AC_ADVISORY =
  'acceptance criteria are placeholders — narrow them via /ditto:deep-interview before acting (IntentContract)';

/**
 * Stronger nudge surfaced when the placeholder situation coincides with an
 * execution-intent prompt (wi_v04intent_autopilot_entry AC-1). Points at the
 * concrete next command. Recommended but not enforced — the hook is advisory.
 */
const DEEP_INTERVIEW_DIRECTIVE =
  'Run /ditto:deep-interview now — placeholder acceptance criteria + execution intent detected. Recommended for complex/irreversible work; may be skipped if the request is small or reversible. Lightweight path for a simple/reversible task: `ditto work set-criteria` → `ditto verify` → `ditto work done` (no deep-interview/autopilot). (IntentContract entry).';

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
   * True in the empty-state (no active pointer + no open work items). Surfaces
   * the work-item guide advisory: 1st-pass judgment + creation-intent
   * confirmation + the concrete `ditto work start` command. Guidance only — the
   * hook never creates a work item or blocks based on this flag.
   */
  workItemGuide?: boolean;
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
  if (ctx.workItemGuide) lines.push('', `⚠ ${WORK_ITEM_GUIDE_ADVISORY}`);
  if (ctx.advisory) lines.push('', `⚠ ${ctx.advisory}`);
  return lines.join('\n');
}
