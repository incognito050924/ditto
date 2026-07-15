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
//
// Reworded to plain, picture-forming Korean (wi_260713nlg): these lines are
// runtime LLM INSTRUCTION injected every turn, not display copy, so the reword
// preserves EVERY operative cue with equal force and polarity (every imperative,
// the forbidden ad-hoc-editing prohibition, the small/reversible→light vs
// ambiguous/irreversible/multi-surface/declared-risk→heavy routing threshold,
// the evidence completion gate). User feedback (wi_260713nlg iter): DITTO-
// internal-only identifiers (final_verdict / IntentContract / QuestionGate) are
// NOT surfaced raw in the banner text — they are expressed in plain Korean. The
// only kept name anchor is 'prime directive' (a conformance test pins it). The
// opaque "금지된 세 번째 길" metaphor is replaced with a self-explanatory
// prohibition. Commands the user types stay literal; "acceptance criterion / AC"
// and "autopilot" are user-facing general terms and stay.
const PRIME_DIRECTIVE = [
  'DITTO 기본 지침(prime directive):',
  '- 원래 요청을 그대로 지킨다: 사용자 승인 없이 범위를 넓히지도, 줄이거나 쪼개지도 않는다.',
  // Defect-class carve-out (wi_2607148yg ac-11): a SEPARATE operative cue, added
  // BESIDE the base prohibition above (which keeps its full force for every
  // non-defect scope change — do NOT fold the two into one softened line). The
  // carve-out is keyed to the CLASSIFIER verdict ("재현되는 실동작 버그"), not a
  // free-text self-label (relabel resistance), and it never opens for non-defects
  // nor waives the two fail-stop conditions. ADR: supersedes ADR-20260627
  // (materialize≠drive) / ADR-20260710 (one-intent=one-unit) for this class only.
  '- 딱 하나의 예외 — 실행 중 발견한 버그: autopilot이 자율 실행 도중 재현되는 실동작 버그를 발견하면(분류기가 "재현되는 실동작 버그"로 판정한 것만 해당한다 — 네가 스스로 "버그"라고 이름 붙였다고 열리지 않는다), 못 본 척 남기지 말고 그 버그를 별도 work item으로 물질화해 같은 run 안에서 고칠 때까지 구동한다. 이 예외는 비-결함(아이디어·기능·기술부채·아직 아무 피해 없는 잠복버그)에는 열리지 않는다 — 그런 후속은 물질화만 하고 구동하지 않으며, 그걸 핑계로 요청 범위를 넓히지 않는다. 이 자율 구동 중에도 두 경우 — 정초 계획·방향이 뒤집히거나 진행이 막힐 때, 그리고 보안·시스템·프로젝트·기능설계 의도를 위협하는 결정이 필요할 때 — 에는 여전히 멈추고 사용자에게 인계한다.',
  '- 코드베이스를 바꾸는 모든 작업은 work item 안에서, 딱 두 갈래 표준 경로로만 진행한다 — 무거운 경로(`/ditto:deep-interview` → autopilot) 또는 가벼운 경로(`ditto work set-criteria` → `ditto verify` → `ditto work done`). 이 두 경로 밖에서 work item 없이 즉흥적으로 코드를 고치는 것(콘솔에서 바로 TDD로 편집)은 허용되지 않는다. TDD는 경로 안에서 구현하는 방법이지, 경로를 대신하는 수단이 아니다.',
  '- 이 요청에 work item이 필요한지, 그리고 어느 경로로 갈지는 네가 판단한다(무게로 라우팅, 권고): 작고 되돌릴 수 있으면 → 가벼운 경로; 모호하거나 되돌릴 수 없거나 여러 표면에 걸치거나 위험이 선언되면 → 무거운 경로. 훅은 절대 자동으로 만들지 않는다. 필요하다고 보면 네가 직접 등록한다: `ditto work start`.',
  '- 사용자만 답할 수 있는 것만 묻는다. 나머지는 코드·문서·웹에서 스스로 답한다.',
  '- 완료는 증거로만 인정된다: 완료(통과)로 판정하기 전에 모든 acceptance criterion을 증거와 함께 닫는다. 기준은 work item 전체이지 중간 체크포인트가 아니다.',
  // User-facing output norms (wi_260715clv). Deliberately injected HERE, in the
  // main-agent per-turn banner, NOT in the shared charter (AGENTS.md): the charter
  // binds EVERY agent incl. non-user-facing subagents, for which these two rules
  // are noise at best and inverted at worst (a subagent MUST cite file:line / ids
  // precisely to its parent). The prime directive reaches only the main agent, the
  // sole producer of user-facing text — so the audience is scoped by the mechanism.
  // Kept language-agnostic ("사용자의 언어로", not a specific language) so it holds
  // for every consumer, and no raw internal id (keeps the opaque-vocab check green).
  '- 사용자에게 보여줄 응답은 사용자의 언어로 자연스럽게 쓴다: 단어 단위로 옮긴 직역체·번역투를 피하고, 단어는 사전적 1:1 대응이 아니라 문맥에 맞는 말로 옮긴다.',
  '- 사용자가 볼 수 없는 것을 달랑 들지 않는다: 사용자가 합의하지 않았거나 매번 찾아보지 않을 내부 번호·식별자·문서를 뜻 없이 이름만 대지 않는다 — 필요하면 그 내용을 그 자리에 풀어 담고, 아니면 뺀다.',
  // Executable self-check routed into the charter (wi_260706n4w): projected
  // verbatim from CHARTER_SELF_CHECKS so the check that left the far-field sweep
  // stays enforced every turn, not archived as documentation.
  ...CHARTER_SELF_CHECKS.map((c) => `- 스스로 점검(${c.id}): ${c.question}`),
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
  '활성 work item이 없다. 1차 판단을 네가 직접 한다: 이 요청이 산출물을 만들거나 되돌릴 수 없는 코드베이스 변경을 일으킨다면 work item으로 등록해야 한다(간단한 작업·핸드오프·git 조작은 예외). 그렇다면 사용자와 의도를 확인한 뒤, 네가 직접 `ditto work start "<목표>" --request "<요청 원문>"`을 실행해 등록한다 — 사용자가 명령을 입력하는 게 아니라 네가 자동으로 만든다. 아니면 평소처럼 진행한다.';

const PLACEHOLDER_AC_ADVISORY =
  'acceptance criteria가 아직 자리표시자다 — 행동하기 전에 /ditto:deep-interview로 구체화하라';

/**
 * Stronger nudge surfaced when the placeholder situation coincides with an
 * execution-intent prompt (wi_v04intent_autopilot_entry AC-1). Points at the
 * concrete next command. Recommended but not enforced — the hook is advisory.
 */
const DEEP_INTERVIEW_DIRECTIVE =
  '지금 /ditto:deep-interview를 실행하라 — acceptance criteria가 아직 자리표시자이고 실행 의도가 감지됐다. 복잡하거나 되돌릴 수 없는 작업에는 권장한다; 요청이 작거나 되돌릴 수 있으면 건너뛰어도 된다. 간단하고 되돌릴 수 있는 작업의 가벼운 경로: `ditto work set-criteria` → `ditto verify` → `ditto work done`(deep-interview·autopilot 없이).';

/**
 * Soft nudge attached to a question-shaped prompt that looks answerable from
 * code/docs (wi_v04intent_autopilot_entry AC-5, QuestionGate). Advisory only —
 * the LLM is not required to follow it, but the heuristic surfaces the option.
 */
const SELF_ANSWER_HINT =
  '묻기 전에 코드·문서·웹에서 먼저 스스로 답하라 — 이 프롬프트는 사용자 입력 없이도 답할 수 있어 보인다.';

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
