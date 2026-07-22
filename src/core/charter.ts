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
    'Is this the smallest, clearest increment that achieves the intent? Is the abstraction proportional to the real complexity — not overbuilt with unrequested features, config, or extensibility, nor a single-use or shallow abstraction (the common failure), and not underbuilt by leaving new duplication behind? Does every changed line trace to the request, with no unrelated refactor or formatting mixed in?',
  origin:
    'far-field taxonomy floor → charter self-check (wi_260706n4w — a design-META quality check, not a far risk, so the every-turn charter enforces it instead of the pre-mortem sweep)',
};

/** All executable charter self-checks (projected every turn, below). */
export const CHARTER_SELF_CHECKS: readonly CharterSelfCheck[] = [MINIMAL_INCREMENT_SELF_CHECK];

// Compressed to tight anchors (wi_260708700): re-injected EVERY turn, so each
// rule is one compact line — enough to re-anchor against drift, without the
// verbose command-lists/how-to that already live in CLAUDE.md/WORKFLOW/skills.
// The minimal-increment self-check is projected VERBATIM (it is a cross-
// referenced SoT — see MINIMAL_INCREMENT_SELF_CHECK) and stays uncompressed.
//
// Rendered in compact ENGLISH (user feedback 2026-07-22): these lines are
// runtime LLM INSTRUCTION injected every turn (internal operation), not text
// addressed to the user, so keeping them English cuts the per-turn token/context
// cost while user-facing OUTPUT still goes out in the user's language. The
// language flip is fidelity-gated (directive-fidelity decision): it preserves
// EVERY operative cue with equal force and polarity (every imperative, the
// forbidden ad-hoc-editing prohibition, the small/reversible→light vs
// ambiguous/irreversible/multi-surface/declared-risk→heavy routing threshold,
// the classifier-keyed defect carve-out with its two fail-stops, the evidence
// completion gate). No raw DITTO-internal identifier is surfaced; the only kept
// name anchor is 'prime directive'. Commands the user types stay literal;
// "acceptance criterion" and "autopilot" are user-facing general terms and stay.
const PRIME_DIRECTIVE = [
  'DITTO prime directive:',
  '- Keep the original request exactly: never widen, shrink, or split its scope without user approval.',
  // Defect-class carve-out (wi_2607148yg ac-11): a SEPARATE operative cue, added
  // BESIDE the base prohibition above (which keeps its full force for every
  // non-defect scope change — do NOT fold the two into one softened line). The
  // carve-out is keyed to the CLASSIFIER verdict ("재현되는 실동작 버그"), not a
  // free-text self-label (relabel resistance), and it never opens for non-defects
  // nor waives the two fail-stop conditions. ADR: supersedes ADR-20260627
  // (materialize≠drive) / ADR-20260710 (one-intent=one-unit) for this class only.
  '- The one exception — a bug found mid-run: if, during an autonomous autopilot run, you hit a reproducible real-behavior bug (ONLY when the classifier rules it a "reproducible real-behavior bug" — your own "bug" label does not open this), do not leave it unseen; materialize it as a separate work item and drive it to a fix within the same run. This exception never opens for non-defects (ideas, features, tech debt, harmless latent bugs) — those are materialized only, never driven, and are no excuse to widen the request. Even during this autonomous drive, still stop and hand off to the user in two cases: the founding plan/direction is overturned or progress is blocked, and a decision threatens security, system, project, or feature-design intent.',
  '- Every codebase change happens inside a work item, on exactly two standard paths — heavy (`/ditto:deep-interview` → autopilot) or lightweight (`ditto work set-criteria` → `ditto verify` → `ditto work done`). Editing code ad hoc without a work item, outside these two paths (TDD straight from the console), is not allowed. TDD is how you implement within a path, not a substitute for one.',
  '- You decide whether this request needs a work item and which path (route by weight, advisory): small and reversible → lightweight; ambiguous, irreversible, spanning several surfaces, or with declared risk → heavy. The hook never auto-creates a work item. If you judge one is needed, register it yourself: `ditto work start`.',
  '- Ask only what only the user can answer; answer everything else yourself from code, docs, or the web.',
  '- Done counts only with evidence: before ruling it done (pass), close every acceptance criterion with evidence. The bar is the whole work item, not an intermediate checkpoint.',
  // User-facing output norms (wi_260715clv). Deliberately injected HERE, in the
  // main-agent per-turn banner, NOT in the shared charter (AGENTS.md): the charter
  // binds EVERY agent incl. non-user-facing subagents, for which these two rules
  // are noise at best and inverted at worst (a subagent MUST cite file:line / ids
  // precisely to its parent). The prime directive reaches only the main agent, the
  // sole producer of user-facing text — so the audience is scoped by the mechanism.
  // Kept language-agnostic ("in the user's language", not a specific one) so it
  // holds for every consumer, and no raw internal id (keeps the opaque-vocab check green).
  "- Write user-facing responses naturally in the user's language: avoid word-for-word translationese, and render each word by context rather than a dictionary 1:1 match.",
  '- Do not dangle things the user cannot see: never drop a bare internal number, identifier, or doc name the user has not agreed on or would not look up — inline its content on the spot, or leave it out.',
  // Executable self-check routed into the charter (wi_260706n4w): projected
  // verbatim from CHARTER_SELF_CHECKS so the check that left the far-field sweep
  // stays enforced every turn, not archived as documentation.
  ...CHARTER_SELF_CHECKS.map((c) => `- self-check (${c.id}): ${c.question}`),
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
  'No active work item. Make the first-pass judgment yourself: if this request produces an artifact or an irreversible codebase change, it should be registered as a work item (simple tasks, handoffs, and git operations are exempt). If so, confirm intent with the user, then register it yourself by running `ditto work start "<goal>" --request "<original request>"` — you create it automatically, the user does not type the command. Otherwise proceed as usual.';

const PLACEHOLDER_AC_ADVISORY =
  'Acceptance criteria are still placeholders — sharpen them with /ditto:deep-interview before acting.';

/**
 * Stronger nudge surfaced when the placeholder situation coincides with an
 * execution-intent prompt (wi_v04intent_autopilot_entry AC-1). Points at the
 * concrete next command. Recommended but not enforced — the hook is advisory.
 */
const DEEP_INTERVIEW_DIRECTIVE =
  'Run /ditto:deep-interview now — acceptance criteria are still placeholders and execution intent was detected. Recommended for complex or irreversible work; skip it if the request is small or reversible. Lightweight path for simple, reversible work: `ditto work set-criteria` → `ditto verify` → `ditto work done` (no deep-interview or autopilot).';

/**
 * Soft nudge attached to a question-shaped prompt that looks answerable from
 * code/docs (wi_v04intent_autopilot_entry AC-5, QuestionGate). Advisory only —
 * the LLM is not required to follow it, but the heuristic surfaces the option.
 */
const SELF_ANSWER_HINT =
  'Answer from code, docs, or the web before asking — this prompt looks answerable without user input.';

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
