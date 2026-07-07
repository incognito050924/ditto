import { z } from 'zod';
import { isoDateTime, schemaVersion, workItemId } from './common';

// Pre-mortem coverage engine — dynamic-growth scope tree (premortem-coverage-contract §3.1·§3.2).
// The tree grows append-only as interrogation proceeds; origin records how each node entered
// (seed = initial decomposition, derived = from an answer, discovered = completeness-critic).

export const coverageOrigin = z
  .enum(['seed', 'derived', 'discovered'])
  .describe('How a coverage node entered the tree (§3.2)');

export const coverageNodeState = z
  .enum(['open', 'resolved', 'user_owned', 'out_of_scope'])
  .describe('Closure state of a coverage node (§3.3)');

// wi_260706n4w ac-1: far-field disposition routing — WHO answers a category, WHEN.
// code-verify = an oracle claim checked against the current code, now;
// user-intent = a user-intent question routed to deep-interview;
// runtime-post-impl = only observable at runtime after the change lands.
// Attached OPTIONAL everywhere it appears (persisted nodes must keep parsing
// pre-change coverage.json — compat); a category with no disposition takes
// DEFAULT_COVERAGE_DISPOSITION.
export const coverageDisposition = z
  .enum(['code-verify', 'user-intent', 'runtime-post-impl'])
  .describe(
    'Far-field category disposition route (who answers, when): code-verify = oracle vs current code now; user-intent = deep-interview question; runtime-post-impl = post-change runtime observation (wi_260706n4w)',
  );

export type CoverageDisposition = z.infer<typeof coverageDisposition>;

/**
 * Default route for a category with no declared disposition (unspecified
 * categories exist — the floor predates this field). `code-verify` preserves the
 * current behavior: the category stays in the pre-mortem sweep and its claims
 * flow through the (fail-open) oracle path, instead of being re-routed to the
 * user or deferred to runtime.
 */
export const DEFAULT_COVERAGE_DISPOSITION: CoverageDisposition = 'code-verify';

export const coverageNode = z
  .object({
    id: z.string().min(1),
    parent_id: z.string().min(1).nullable().describe('Parent node id; null for the root'),
    label: z.string().min(1),
    origin: coverageOrigin,
    depth_weight: z.number().describe('Estimated needed depth (§4.4)'),
    state: coverageNodeState,
    children: z
      .array(z.string().min(1))
      .default([])
      .describe('Child node ids (flat array + parent_id represents the tree/DAG)'),
    close_reason: z
      .string()
      .optional()
      .describe(
        'Recorded justification when the node is closed in a non-resolved state — a skip/deferral must be justified, never silent (§8-2, ac-2)',
      ),
    residual_risk: z
      .string()
      .optional()
      .describe(
        'The surviving risk a non-resolved close leaves behind (out_of_scope/user_owned) — distinct from close_reason (WHY skipped); this names WHAT RISK survives the skip. Required for a non-resolved close, recorded on the node (surviving-risk self-description gap)',
      ),
    // wi_260706n4w ac-1: additive + OPTIONAL (pre-change coverage.json parses
    // unchanged, no schema_version bump); absent = DEFAULT_COVERAGE_DISPOSITION.
    disposition: coverageDisposition
      .optional()
      .describe('Disposition route of a category node; absent = DEFAULT_COVERAGE_DISPOSITION'),
  })
  .describe('One node in the coverage scope tree (§3.1)');

export const coverageTier = z
  .enum(['light', 'standard', 'full'])
  .describe('Sweep intensity tier — scales sweepAngles and termination depth K (§8-4, ac-4)');

export const coverageMap = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    root_id: z.string().min(1).describe('Id of the root node (user original intent)'),
    nodes: z.array(coverageNode).default([]),
    intensity: coverageTier
      .optional()
      .describe(
        'Entry intensity override (ac-4) persisted on the first seed so the tier and termination depth K stay consistent across every round without the caller re-passing it (§8-4)',
      ),
  })
  .describe('Coverage map sidecar (coverage.json) — additive dynamic-growth scope tree (§9)');

export type CoverageNode = z.infer<typeof coverageNode>;
export type CoverageMap = z.infer<typeof coverageMap>;

// Relevance provenance (wi_26062227h) — the audit sidecar the relevance gate leaves
// at seed. coverage.json persists only the ASSEMBLED node state, so a category kept
// relevant loses whether the judge proposed skipping it and a refute overturned that
// (the §5-3 path). Persisting the RAW judgments + refutes makes the skip-cause
// diagnosable post-hoc (b: conservative-correct vs c: proposed-skip-then-refuted) and
// carries the structural cost tally. Token/wall-time is deliberately absent: subagent
// cost is host-delegated (ADR-0001), never visible to the deterministic engine.
export const rawRelevanceJudgment = z
  .object({
    id: z.string().min(1).describe('Floor category id (bare, no cov-cat- prefix)'),
    relevant: z.boolean(),
    reason: z.string().optional().describe('Why irrelevant — becomes close_reason on a skip'),
    residual_risk: z.string().optional().describe('What risk survives the skip'),
  })
  .describe('One raw per-category relevance judgment from the grounded relevance agent (§5-2)');

export const relevanceRefute = z
  .object({
    id: z.string().min(1),
    refuted: z
      .boolean()
      .describe('true = refuter found the category IS relevant → skip overturned'),
  })
  .describe('One adversarial refute outcome for a proposed skip (§5-3)');

export const relevanceProvenance = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    judgments: z.array(rawRelevanceJudgment).describe('Raw grounded judgments, pre-assembly'),
    refutes: z.array(relevanceRefute).describe('Raw adversarial refutes, pre-assembly'),
    tally: z
      .object({
        seeded: z.number().int().nonnegative().describe('Category nodes seeded (breadth floor)'),
        skipped: z.number().int().nonnegative().describe('Categories pre-closed out_of_scope'),
        relevant: z.number().int().nonnegative().describe('Categories left open to be swept'),
      })
      .describe('Structural cost tally — the only run-cost proxy the engine can see (no tokens)'),
  })
  .describe('Relevance gate audit sidecar (relevance-provenance.json, §9) — wi_26062227h');

export type RawRelevanceJudgment = z.infer<typeof rawRelevanceJudgment>;
export type RelevanceRefute = z.infer<typeof relevanceRefute>;
export type RelevanceProvenance = z.infer<typeof relevanceProvenance>;

// ── 2-mode oracle claim + verdict (wi_260706n4w ac-1/ac-2) ─────────────────
// A claim is UNTRUSTED LLM output. The schema persists it RAW (loose strings):
// rejecting a malformed claim at parse time would make a fabricated claim
// unpersistable and therefore unlabelable (the ac-5 verdict-blind labeler needs
// the raw claim). Decidability — token-shaped pattern + containment-valid
// scope_path — is the executor shape gate's call (n4), NOT the parser's; a
// non-decidable claim routes to advisory, never to a hard verdict.

export const oracleMode = z
  .enum(['presence', 'absence'])
  .describe(
    'Oracle claim mode: presence = the cited anchor exists (file:line, codePointerMapsTo vocabulary); absence = the token does not occur in scope (wi_260706n4w)',
  );

/**
 * Decidable-pattern token shape — mirrors ANCHOR_TOKEN (core coverage-manager
 * isReEvaluableAnchor): a single non-whitespace token, never prose. The shape
 * gate's SoT; deliberately NOT applied at parse time (raw claims persist).
 */
export const ORACLE_PATTERN_TOKEN_RE = /^[^\s]+$/;

/** Length cap on a decidable pattern (shape gate, with ORACLE_PATTERN_TOKEN_RE). */
export const ORACLE_PATTERN_MAX_LENGTH = 200;

/**
 * Shape-gate predicate (wi_260706n4w): hard-verdict eligible iff the pattern is
 * a single non-whitespace fixed-string token within the length cap. Prose /
 * whitespace / oversize → not decidable → advisory (tier-independent). Same
 * anchor-vs-label separation as core isReEvaluableAnchor.
 */
export function isDecidableOraclePattern(pattern: string): boolean {
  return (
    pattern.length > 0 &&
    pattern.length <= ORACLE_PATTERN_MAX_LENGTH &&
    ORACLE_PATTERN_TOKEN_RE.test(pattern)
  );
}

export const oracleClaim = z
  .discriminatedUnion('mode', [
    z.object({
      mode: z.literal('presence'),
      maps_to: z
        .string()
        .min(1)
        .describe(
          'file:line citation the claim says EXISTS — reuses the codePointerMapsTo grammar (work-item.ts); no new citation syntax. Existence (file real + line present) is checked by the executor',
        ),
    }),
    z.object({
      mode: z.literal('absence'),
      pattern: z
        .string()
        .min(1)
        .describe(
          'Fixed-string token the claim says does NOT occur under scope_path. Decidable iff ORACLE_PATTERN_TOKEN_RE + ORACLE_PATTERN_MAX_LENGTH (n4 shape gate); non-decidable → advisory',
        ),
      scope_path: z
        .string()
        .min(1)
        .describe(
          'Repo-relative scope of the absence claim. Containment-checked before any exec (n4 trust boundary), NOT at parse time — a fabricated path must still persist for labeling',
        ),
    }),
  ])
  .describe(
    'One 2-mode oracle claim: presence = cited anchor exists; absence = "pattern does not occur under scope_path" (wi_260706n4w ac-1)',
  );

export type OracleMode = z.infer<typeof oracleMode>;
export type OracleClaim = z.infer<typeof oracleClaim>;

// Verdict — the exit 3-way branch is representable WITHOUT coercion (`git grep`
// semantics: 0 = match, 1 = no match, ≥2 = error). For an absence claim:
// exit 1 → confirmed(-absent), exit 0 → refuted (the claimed-absent token is
// real → fabricated claim), exit ≥2 → advisory_unverified. An exec error is
// NEVER coerced to "absent" (the cleanup-scan exitCode!==0 collapse is the
// documented anti-pattern — do not copy).
export const oracleVerdictOutcome = z
  .enum(['confirmed', 'refuted', 'advisory_unverified'])
  .describe(
    'Exit 3-way verdict: confirmed = claim held (absence: exit 1); refuted = claim contradicted (absence: exit 0); advisory_unverified = could not decide — never coerced to absent (wi_260706n4w ac-2)',
  );

// Strictness applied to a DECIDABLE refuted claim: risk-tier categories
// (injection / secret-exposure) fail closed (hard_reject); everything else is
// advisory. A non-decidable claim is advisory regardless of tier (shape gate
// first, tier strength on top).
export const oracleEnforcementTier = z
  .enum(['hard_reject', 'advisory'])
  .describe(
    'Enforcement strength applied to the claim: hard_reject = decidable-refuted fails closed (injection/secret risk tier); advisory = signal only (wi_260706n4w ac-2)',
  );

export const oracleAdvisoryReason = z
  .enum(['shape_gate', 'exec_error', 'tool_absent'])
  .describe(
    'Why the verdict degraded to advisory: shape_gate = non-decidable claim shape (prose pattern / containment-invalid scope); exec_error = executor exit ≥2; tool_absent = optional tool missing (ADR-0018 graceful degradation)',
  );

export const oracleVerdict = z
  .object({
    claim_id: z
      .string()
      .min(1)
      .describe(
        'Stable claim id — the correlation key shared with labeler_labels[] (the deterministic tally joins the two independent sets on it)',
      ),
    category_id: z
      .string()
      .min(1)
      .optional()
      .describe('Coverage category the claim belongs to (bare floor id or cov-cat-*)'),
    claim: oracleClaim,
    outcome: oracleVerdictOutcome,
    tier: oracleEnforcementTier,
    advisory_reason: oracleAdvisoryReason.optional(),
    exit_code: z
      .number()
      .int()
      .optional()
      .describe(
        'Raw executor exit code evidence (git grep semantics: 0 match / 1 no-match / ≥2 error)',
      ),
    detail: z.string().optional().describe('Free-text executor detail (e.g., stderr excerpt)'),
  })
  .superRefine((value, ctx) => {
    if (value.outcome === 'advisory_unverified' && !value.advisory_reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'advisory_unverified requires advisory_reason (shape_gate | exec_error | tool_absent) — degradation must be self-describing, never silent (wi_260706n4w ac-2)',
        path: ['advisory_reason'],
      });
    }
  })
  .describe('One raw oracle verdict over a 2-mode claim (ENFORCE set, wi_260706n4w)');

export type OracleVerdictOutcome = z.infer<typeof oracleVerdictOutcome>;
export type OracleEnforcementTier = z.infer<typeof oracleEnforcementTier>;
export type OracleAdvisoryReason = z.infer<typeof oracleAdvisoryReason>;
export type OracleVerdict = z.infer<typeof oracleVerdict>;

// Oracle/labeler audit sidecar (wi_260706n4w ac-4/ac-5) — mirrors
// relevanceProvenance above: raw judgments persist as SEPARATE arrays plus a
// deterministic tally. oracle = ENFORCE, labeler = JUDGE (verdict-blind: its
// input is the raw claim + the codebase, never an oracle verdict), and the
// tally is the CORRELATE slot — computed by deterministic ditto code over the
// two independent sets (fabrication-rate measurement), never by either agent.
export const labelerLabel = z
  .object({
    claim_id: z
      .string()
      .min(1)
      .describe('Correlation key — same id space as oracle_verdicts[].claim_id'),
    label: z
      .enum(['real', 'fabricated'])
      .describe('Labeler judgment of the raw claim against the codebase'),
    reason: z.string().optional().describe('Labeler justification'),
  })
  .describe(
    'One raw verdict-blind labeler judgment (input = raw claim + codebase, NEVER the oracle verdict — wi_260706n4w ac-5)',
  );

export const oracleProvenance = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    oracle_verdicts: z
      .array(oracleVerdict)
      .describe('Raw oracle verdicts (ENFORCE set), pre-correlation'),
    labeler_labels: z
      .array(labelerLabel)
      .describe('Raw verdict-blind labeler labels (JUDGE set), pre-correlation'),
    tally: z
      .object({
        claims: z.number().int().nonnegative().describe('Total raw claims considered'),
        oracle: z
          .object({
            confirmed: z.number().int().nonnegative(),
            refuted: z.number().int().nonnegative(),
            advisory_unverified: z.number().int().nonnegative(),
          })
          .describe('Oracle outcome counts (ENFORCE set)'),
        labeler: z
          .object({
            real: z.number().int().nonnegative(),
            fabricated: z.number().int().nonnegative(),
          })
          .describe('Labeler label counts (JUDGE set)'),
      })
      .describe(
        'Deterministic CORRELATE slot — computed by ditto code over the two independent sets (never by either agent); the fabrication-rate before/after measurement reads this (n9)',
      ),
  })
  .describe(
    'Oracle-verdict + labeler audit sidecar (oracle-provenance.json) — mirrors relevanceProvenance (wi_260706n4w ac-4/ac-5)',
  );

export type LabelerLabel = z.infer<typeof labelerLabel>;
export type OracleProvenance = z.infer<typeof oracleProvenance>;

// Plan-stage coverage-round payload (§4·§5 wiring) — the structural signals the
// fresh fan-out hands back to the deterministic Manager via `coverage-round`. The
// Manager appends children (append-only), steps the dry counter, and — on
// `close_as` — runs the six §2 axis mechanisms + false-green gate. The
// natural-language `label` is carried but never interpreted by code (§4.1).
const coverageChildInput = z.object({
  id: z.string().min(1),
  parent_id: z.string().min(1),
  label: z.string().min(1),
  origin: z.enum(['derived', 'discovered']),
  depth_weight: z.number(),
});

export const coverageRoundPayload = z
  .object({
    node_id: z.string().min(1),
    derived_nodes: z.array(coverageChildInput).default([]),
    discovered_nodes: z.array(coverageChildInput).default([]),
    admissibleBranchesAdded: z.number().int().nonnegative(),
    close_as: z.enum(['resolved', 'user_owned', 'out_of_scope']).optional(),
    close_reason: z
      .string()
      .optional()
      .describe(
        'Justification for a skip/deferral close (out_of_scope/user_owned) — required to skip a seeded category, recorded on the node (§8-2, ac-2)',
      ),
    residual_risk: z
      .string()
      .optional()
      .describe(
        'The surviving risk a skip/deferral close leaves behind — required alongside close_reason for a non-resolved close, recorded on the node (surviving-risk self-description gap)',
      ),
    oracle_claims: z
      .array(
        z.object({
          claim_id: z
            .string()
            .min(1)
            .describe(
              'Stable claim id — correlation key shared with oracle_verdicts[]/labeler_labels[]',
            ),
          category_id: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Coverage category the claim belongs to (bare floor id or cov-cat-*); absent → inherited from the round node (ancestor walk)',
            ),
          claim: oracleClaim,
        }),
      )
      .optional()
      .describe(
        "Raw oracle-linked claims this round's sweep surfaced (wi_260706n4w ac-1) — the CLI threads them to recordCoverageRound's oracle seam, where code-verify claims are evaluated by the deterministic 2-mode oracle. Additive optional: absent → unchanged behavior (ac-6)",
      ),
    axis_signals: z
      .object({
        neutrality: z
          .object({
            opponent_ran: z.boolean(),
            verdict: z.enum(['accept', 'revise', 'reject', 'blocked']),
          })
          .optional(),
        balance: z
          .object({
            achievedDepth: z.number(),
            open_required_sections: z.number(),
            conflicting: z.number(),
            assumption_ratio: z.number(),
          })
          .optional(),
        priority: z
          .object({
            userPriority: z.enum(['high', 'normal', 'low']),
            achievedDepth: z.number(),
          })
          .optional(),
        temporalBaseline: z.array(z.string()).optional(),
        temporalCurrent: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .describe('One coverage interrogation round handed back to the deterministic Manager (§5)');

export type CoverageRoundPayload = z.infer<typeof coverageRoundPayload>;

// Tier-② project taxonomy config (ac-10) — `.ditto/coverage-taxonomy.json`, git-tracked
// (team-shared, NOT the per-developer tier-③ `.ditto/local/config.json`). DITTO ships a
// good floor; a project enables/disables/adds categories here to reflect its own auth
// model / domain. Absent or malformed → the code floor (fail-open). Each added category
// is a probing-QUESTION lens (ac-1), not a bare noun.
export const coverageTaxonomyConfig = z
  .object({
    disabled: z
      .array(z.string().min(1))
      .optional()
      .describe('Floor category ids to turn off for this project (ac-10)'),
    added: z
      .array(
        z.object({
          id: z.string().min(1),
          lens: z.string().min(1).describe('Probing-question lens the sweep answers (ac-1)'),
          // wi_260706n4w ac-1: additive + OPTIONAL — legacy configs parse unchanged.
          disposition: coverageDisposition
            .optional()
            .describe('Disposition route of the added category; absent = default'),
        }),
      )
      .optional()
      .describe(
        'Project-added categories (id + probing-question lens); id collision overrides a floor lens',
      ),
    // wi_260706n4w ac-1: tier-② disposition override for FLOOR categories (the
    // `added` entries carry their own `disposition` field; this map re-routes a
    // category the code floor ships). Additive + OPTIONAL — legacy configs parse
    // unchanged; absent/malformed follows the config-wide fail-open rule.
    dispositions: z
      .record(z.string().min(1), coverageDisposition)
      .optional()
      .describe('Floor-category id → disposition route override (tier-②, wi_260706n4w)'),
  })
  .describe(
    'Tier-② project far-field taxonomy config (.ditto/coverage-taxonomy.json, git-tracked) — ac-10',
  );

export type CoverageTaxonomyConfig = z.infer<typeof coverageTaxonomyConfig>;

// ac-11b outcome loop — a coverage escape (a fault that slipped past the floor) is
// fed back so the taxonomy can learn. `coverageFeedback` is the input the
// `ditto coverage feedback` command accepts; `coverageFeedbackEntry` is one
// append-only jsonl row the command records.

export const coverageFeedback = z
  .object({
    work_item_id: workItemId,
    category_id: z
      .string()
      .min(1)
      .describe('Coverage category the escape belongs to (cov-cat-* or a floor category id)'),
    evidence: z
      .string()
      .min(1)
      .describe('Triggering-failure evidence text — what slipped past coverage (ac-11b)'),
  })
  .describe('Input to `ditto coverage feedback` — a coverage-escape report (ac-11b)');

// depth/breadth are the two FAR-FIELD escapes (a fault that slipped past the
// floor sweep) — these feed the far-field cost/escape aggregation. `residual` is
// NOT a far-field escape: it records a general followup / residual-risk row in
// the SAME ledger so it is kept, but the far-field cost stats exclude it
// (wi_26062257r ac-3). Keep `isFarFieldEscape` below in sync with this enum.
export const coverageFaultKind = z
  .enum(['depth', 'breadth', 'residual'])
  .describe(
    'depth = an existing category that was resolved still broke (under-probed); breadth = a category the floor never seeded (missing lens); both are far-field escapes. residual = a general followup / residual-risk row recorded in the ledger but EXCLUDED from far-field cost aggregation (ac-3, wi_26062257r)',
  );

/**
 * The far-field escape kinds (depth/breadth) — the kinds the far-field
 * cost/escape aggregation counts. `residual` is recorded in the ledger but
 * excluded here, so it stays invisible to the far-field cost judgement (ac-3).
 */
export const FAR_FIELD_ESCAPE_KINDS = ['depth', 'breadth'] as const;

export function isFarFieldEscape(kind: CoverageFaultKind): boolean {
  return (FAR_FIELD_ESCAPE_KINDS as readonly string[]).includes(kind);
}

export const coverageFeedbackEntry = z
  .object({
    work_item_id: workItemId,
    category_id: z.string().min(1).describe('Coverage category the escape is attributed to'),
    fault_kind: coverageFaultKind,
    evidence: z.string().min(1).describe('Triggering-failure evidence text'),
    recorded_at: isoDateTime.describe('When the feedback row was appended (set by the core node)'),
  })
  .describe('One append-only row in the coverage-feedback jsonl ledger (ac-11b)');

export type CoverageFeedback = z.infer<typeof coverageFeedback>;
export type CoverageFaultKind = z.infer<typeof coverageFaultKind>;
export type CoverageFeedbackEntry = z.infer<typeof coverageFeedbackEntry>;
