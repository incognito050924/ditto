import { z } from 'zod';
import { isoDateTime, schemaVersion, workItemId } from './common';
import { closureMode, confidenceLevel, honestyKind } from './convergence';
import { selfAnswerAttempt } from './question-gate';

export const interviewStatus = z
  .enum(['active', 'converged', 'deferred', 'aborted'])
  .describe('Lifecycle of the deep interview');

export const dimensionState = z
  .enum(['unknown', 'partial', 'resolved'])
  .describe('Resolution state of one ambiguity dimension');

export const infoGain = z
  .enum(['high', 'medium', 'low'])
  .describe('Estimated information gain of a question');

// User's own report, when answering, of whether they had enough comprehensible
// context to decide. The success proxy for the presentation contract (wi_260622ph8):
// "did you have enough to answer?" is observable where "did you understand?" is not.
export const answerSelfReport = z
  .enum(['confident', 'partial', 'unsure'])
  .describe(
    'User self-report of decision-ability after answering (presentation-sufficiency signal)',
  );

// Intent-layer dissent recorded on a dimension by the deep-interview opponent seam
// (wi_260709mqt). Optional on the dimension so pre-existing interview-state.json parse
// unchanged (same pattern as user_confirmation / review_status). `status` distinguishes
// a REAL engaged opponent judgment from an ADR-0018 host_absent degrade — never a fake
// pass. `impact:'high'` on a critical dimension is the finalize block trigger until the
// user acknowledges it; the whole record is a durable snapshot so resume/retry reads the
// same verdict without re-invoking the (non-deterministic) opponent.
export const interviewDissent = z
  .object({
    status: z.enum(['engaged', 'host_absent']),
    verdict: z.enum(['accept', 'revise', 'reject']).optional(),
    impact: z.enum(['low', 'high']).optional(),
    text: z.string().optional(),
    acknowledged: z.boolean().default(false),
  })
  .describe('Intent-layer opponent dissent recorded on a dimension (wi_260709mqt)');

export type InterviewDissent = z.infer<typeof interviewDissent>;

// Host-delegated intent-dissent verdicts fed to `ditto deep-interview dissent-record`
// (wi_260709x5w, pass-in-JSON seam mirroring prismOpponentVerdicts). The model judgment
// happens in the spawned intent-dissent-opponent agent (ADR-0001); the CLI only consumes
// the structured output. `dimension_id` and `text` are non-empty by schema (first defense);
// the fail-closed dimension-membership guard + the whitespace-text→host_absent degrade live
// in the driver/CLI, since the schema cannot see the interview state.
export const interviewDissentVerdict = z
  .object({
    dimension_id: z.string().min(1).describe('The interview dimension this dissent is recorded on'),
    text: z
      .string()
      .min(1)
      .describe('The opponent’s sharper-intent judgment text (host-produced, ADR-0001)'),
  })
  .describe('One host-delegated intent-dissent verdict consumed by dissent-record');

export type InterviewDissentVerdict = z.infer<typeof interviewDissentVerdict>;

export const interviewDissentVerdicts = z
  .object({
    verdicts: z
      .array(interviewDissentVerdict)
      .min(1)
      .describe('The intent-dissent verdicts to record (at least one)'),
  })
  .describe('The --json payload for `ditto deep-interview dissent-record`');

export type InterviewDissentVerdicts = z.infer<typeof interviewDissentVerdicts>;

// Host-delegated A1 semantic-critic verdicts fed to `ditto deep-interview semantic-record`
// (wi_260709hzg, #15 — mirrors interviewDissentVerdict). The achieve-vs-characterize judgment
// happens in the spawned semantic-critic agent (ADR-0001); the CLI only consumes the
// structured output. `dimension_id` targets a covered dimension; the fail-closed
// membership guard + the whitespace-text→host_absent degrade live in the driver/CLI.
export const interviewSemanticVerdict = z
  .object({
    dimension_id: z.string().min(1).describe('The covered dimension this critique is recorded on'),
    text: z
      .string()
      .min(1)
      .describe('The achieve-vs-characterize judgment (host-produced, ADR-0001)'),
  })
  .describe('One host-delegated A1 semantic-critic verdict consumed by semantic-record');

export type InterviewSemanticVerdict = z.infer<typeof interviewSemanticVerdict>;

export const interviewSemanticVerdicts = z
  .object({
    verdicts: z
      .array(interviewSemanticVerdict)
      .min(1)
      .describe('The A1 semantic-critic verdicts to record (at least one)'),
  })
  .describe('The --json payload for `ditto deep-interview semantic-record`');

export type InterviewSemanticVerdicts = z.infer<typeof interviewSemanticVerdicts>;

export const interviewDimension = z
  .object({
    id: z.string().min(1),
    critical: z.boolean().default(false),
    state: dimensionState,
    ambiguity: z.number().min(0).max(1),
    resolved_by: z.array(z.string()).default([]),
    notes: z.string().default(''),
    // Intent-dissent record-back (wi_260709mqt). Fully optional — absent for every
    // pre-existing state and for non-critical dimensions the opponent never faces.
    dissent: interviewDissent.optional(),
    // A1 achieve-vs-characterize semantic critic (wi_260709hzg, #15) — the intent-layer
    // port of prism's A1. ADVISORY and NON-blocking: the readiness gate never reads these
    // fields, so a `characterize`-only verdict surfaces the intent-fulfilment gap WITHOUT
    // blocking the interview loop (prism A1 is likewise non-blocking). A SEPARATE field pair
    // from `dissent` so per-seam degrade attribution never mixes. `semantic_status`
    // distinguishes a real engaged judgment from an ADR-0018 host_absent degrade. Both
    // optional so pre-existing state and every uncovered dimension parse unchanged.
    semantic_status: z
      .enum(['engaged', 'host_absent'])
      .optional()
      .describe('A1 semantic-critic seam status; host_absent on degrade (ADR-0018), advisory'),
    semantic_critique: z
      .string()
      .optional()
      .describe('A1 achieve-vs-characterize judgment on a covered (fragment,dimension) pair'),
  })
  .describe('One ambiguity dimension tracked during the interview');

export type InterviewDimension = z.infer<typeof interviewDimension>;

export const interviewQuestion = z
  .object({
    id: z.string().min(1),
    asked_at: isoDateTime,
    dimension: z.string().min(1),
    question: z.string().min(1),
    why_matters: z.string().min(1).describe('What changes depending on the answer'),
    info_gain_estimate: infoGain,
    self_answer_attempts: z.array(selfAnswerAttempt).default([]),
    // Presentation contract (wi_260622ph8). These carry the comprehensible,
    // decision-sufficient context the user needs WITH the question. All optional so
    // pre-existing interview-state.json parse unchanged; the gate (check-question)
    // enforces user_explanation presence before a question is asked.
    user_explanation: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Plain-language why-we-ask + what-the-answer-decides — user language, no raw code/jargon (default-shown)',
      ),
    // recommended_answer (impl-di-recommended-answer, ac-3). ADDITIVE-OPTIONAL so pre-existing
    // interview-state.json parse unchanged; the check-question gate hard-requires it before ask.
    recommended_answer: z
      .string()
      .min(1)
      .optional()
      .describe('The agent’s suggested default answer (user language) carried with the question'),
    background: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Deeper context for progressive disclosure ("more") — optional expansion beyond user_explanation',
      ),
    grounding: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Evidence the question stems from (file:line | doc | domain) — the source behind why-we-ask',
      ),
    // Session-blind context-review outcome for a critical question (wi_260628, D2).
    // Optional so pre-existing interview-state.json parse unchanged; only critical
    // questions carry it. 'reviewed' = the session-blind reviewer passed it;
    // 'unverified-degraded' = reviewer unavailable or the regeneration cap was
    // exhausted — surfaced to the user honestly, never silently asked (ADR-0018 D2).
    review_status: z
      .enum(['reviewed', 'unverified-degraded'])
      .optional()
      .describe('Session-blind context-review outcome (critical questions only)'),
    answer: z.string().optional(),
    answer_kind: z.enum(['user', 'assumption']).optional(),
    answer_self_report: answerSelfReport
      .optional()
      .describe(
        'User self-report of decision-ability after answering (presentation-sufficiency signal)',
      ),
    ambiguity_delta: z.number().optional(),
    marginal_gain: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Score-gated marginal information gain of this round; low value across a round is the dry signal',
      ),
    // wi_260709d00 (#14): did THIS round add admissible novelty? The angle-exhaustion twin of
    // marginal_gain's value-exhaustion — carried per turn (like marginal_gain) so the driver
    // reconstructs the novelty dry-counter deterministically from disk (no stored counter).
    // Additive-optional: legacy state (field absent) parses unchanged and never triggers early
    // termination (fail-open). Same boolean the gate loop records as questionRound.novelty.
    novelty: z
      .boolean()
      .optional()
      .describe(
        'Whether this round added admissible novelty (deterministic; angle-exhaustion axis)',
      ),
  })
  .describe('One asked question with its self-answer attempts and outcome');

export const interviewAssumption = z
  .object({
    statement: z.string().min(1),
    label: honestyKind,
    confidence: confidenceLevel,
    because_no_answer_to: z.string().min(1).describe('Question id left unanswered'),
  })
  .describe('Assumption recorded when a question was not answered (§6.9)');

// Pre-mortem item (deep-interview §5). Each surfaced risk scenario; an
// irreversible / high-blast item MUST be promoted (not merely recorded) into one
// of: a new acceptance criterion, out_of_scope + rationale, or a
// user_owned_decision question (§5 승격 규칙). `promoted_to`/`ref` record where it
// landed so the promotion is provable, not a bare boolean.
export const premortemItem = z
  .object({
    scenario: z.string().min(1).describe('What failed / caused harm if this shipped'),
    likelihood: z.enum(['low', 'medium', 'high']),
    blast_radius: z.enum(['low', 'medium', 'high', 'critical']),
    reversibility: z.enum(['reversible', 'hard', 'irreversible']),
    early_signal: z
      .string()
      .default('')
      .describe('What you would observe if this risk is materializing'),
    promoted_to: z
      .enum(['ac', 'out_of_scope', 'user_owned_decision', 'none'])
      .describe('Where a critical item was promoted (§5 승격 규칙)'),
    ref: z.string().default('').describe('Pointer to the AC / out_of_scope[i] / question id'),
    // Oracle-link (wi_260709d3m, #17 AC-1). Evidence the promoted risk binds to —
    // original-intent fragment id | file:line | ADR — a scaled-down version of coverage's
    // anti-SLOP axis (a risk with no oracle is taste). OPTIONAL: when the risk cannot be
    // bound to an oracle it stays prose (never forced), so the §5 promotion rule and its
    // fail-closed gate are unchanged. Pre-existing interview-state.json parse unaffected.
    maps_to: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Oracle-link: original-intent fragment | file:line | ADR the risk binds to'),
    // Lightweight opponent refutation (wi_260709d3m, #17 AC-2). Recorded ONLY on a
    // blast_radius>=high item — a single host-delegated "is this risk real / already
    // mitigated?" pass. `status` distinguishes a REAL engaged judgment from an ADR-0018
    // host_absent degrade (never a fake pass). OPTIONAL so pre-existing items and every
    // low-blast item parse unchanged. Folded by `recordPremortemRefutation` / the
    // `premortem-refute-record` CLI, never written inline (host runs the opponent, ADR-0001).
    refutation: z
      .object({
        status: z.enum(['engaged', 'host_absent']),
        text: z.string().optional().describe('The opponent’s refutation judgment (host-produced)'),
      })
      .optional()
      .describe('Lightweight opponent refutation on a high-blast item (host-delegated)'),
  })
  .describe('One pre-mortem risk item with its promotion outcome (deep-interview §5)');

export type PremortemItem = z.infer<typeof premortemItem>;

// Host-delegated pre-mortem refutation verdicts fed to `ditto deep-interview
// premortem-refute-record` (wi_260709d3m, #17 AC-2 — mirrors interviewDissentVerdict). The
// model judgment happens in the spawned opponent agent (ADR-0001); the CLI only consumes the
// structured output. `index` targets a recorded premortem item; the fail-closed
// range/high-blast-membership guard + the whitespace-text→host_absent degrade live in the
// driver/CLI, since the schema cannot see the interview state.
export const premortemRefutationVerdict = z
  .object({
    index: z
      .number()
      .int()
      .min(0)
      .describe('Index into interview-state.premortem the refutation targets'),
    text: z
      .string()
      .min(1)
      .describe('The opponent’s refutation judgment (host-produced, ADR-0001)'),
  })
  .describe('One host-delegated pre-mortem refutation verdict consumed by premortem-refute-record');

export type PremortemRefutationVerdict = z.infer<typeof premortemRefutationVerdict>;

export const premortemRefutationVerdicts = z
  .object({
    verdicts: z
      .array(premortemRefutationVerdict)
      .min(1)
      .describe('The pre-mortem refutation verdicts to record (at least one)'),
  })
  .describe('The --json payload for `ditto deep-interview premortem-refute-record`');

export type PremortemRefutationVerdicts = z.infer<typeof premortemRefutationVerdicts>;

// 축1 종료 = readiness 게이트(1차, 시스템) ∧ 사용자 확인(2차, 휴먼). The second
// condition: the user confirmed the synthesized intent matches their understanding.
// Carries the user's own words (`statement`) as evidence — `confirmed=true` is not
// a bare self-declared boolean (claim ≠ proof). finalize enforces both as an AND.
export const userConfirmation = z
  .object({
    confirmed: z
      .boolean()
      .describe('The user confirmed the synthesized intent matches their understanding'),
    statement: z
      .string()
      .default('')
      .describe("The user's own words confirming; required (non-empty) when confirmed=true"),
    confirmed_at: isoDateTime.optional().describe('When the confirmation was captured'),
  })
  .superRefine((value, ctx) => {
    if (value.confirmed && value.statement.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'confirmed=true requires the user statement (evidence, not a bare boolean)',
        path: ['statement'],
      });
    }
  })
  .describe('축1 2차 게이트: explicit, evidence-bearing user confirmation of the intent');

export const interviewState = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    status: interviewStatus,
    started_at: isoDateTime,
    updated_at: isoDateTime,
    dimensions: z.array(interviewDimension).default([]),
    readiness: z.object({
      score: z.number().min(0).max(1),
      threshold: z.number().min(0).max(1),
      critical_unresolved: z.array(z.string()).default([]),
      gate: z.enum(['blocked', 'ready']),
    }),
    questions: z.array(interviewQuestion).default([]),
    assumptions: z.array(interviewAssumption).default([]),
    // Pre-mortem items surfaced during the interview (deep-interview §5). Optional
    // so pre-existing interview-state.json parse unchanged; populated by the
    // premortem-promotion step which closes the risk_reversibility dimension.
    premortem: z.array(premortemItem).default([]),
    // The 2차 (user-confirmation) half of the axis-1 closure gate, recorded when
    // the interview is finalized. Optional so an active/pre-confirmation interview
    // and every pre-existing interview-state.json parse unchanged.
    user_confirmation: userConfirmation.optional(),
    exit: z.object({
      reason: z.enum([
        'readiness_met',
        'diminishing_returns',
        'user_deferred',
        'user_owned_decision',
        'cap_reached',
      ]),
      closure_mode: closureMode,
      question_cap: z.number().int().positive(),
      questions_asked: z.number().int().nonnegative(),
    }),
  })
  .describe('Deep interview sidecar tracking ambiguity dimensions and readiness (§6.3)');

export type InterviewState = z.infer<typeof interviewState>;
