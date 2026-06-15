/**
 * Unit-scoped refactor decision (80-plan §9/§4.4, WU-4). This is the STANDING-code
 * counterpart to the change-scoped Tidy gating: the user names an architecture unit,
 * the unit is resolved to a file set (see `~/acg/scope/unit-resolve`), and we measure
 * the unit's ABSOLUTE fitness debt at baseline = HEAD (a snapshot violation COUNT, not
 * the drift delta-trend), then gate the bar-met commit.
 *
 * PROVIDER-PRESENCE-FIRST (N8 measure-first finding, dialectic-9 OBJ-04): no coverage
 * provider is wired in this repo (0건), and `assessBehaviorLock` short-circuits to
 * degraded/diff-only BEFORE consulting coverage when no provider is present. So for
 * standing code TODAY full-bar auto-commit is structurally unreachable and every unit
 * collapses uniformly to diff-only. We therefore:
 *   1. block when the baseline suite is red (tidy cannot start);
 *   2. degrade-ALL to diff-only when NO coverage provider is present (default);
 *   3. only when a provider IS present, branch per-unit on covered + behavior-green +
 *      debt-decreased to reach the full bar (bar-met → isolated-branch commit).
 * Bar-miss portions surface as NARROW residual questions, never a bulk diff to approve
 * (§4.4 — bulk-diff approval is 검증 연극).
 */

/** Absolute unit debt — the unit's own violation COUNT before/after (ac-9). */
export interface UnitDebt {
  before: number;
  after: number;
  removed: number;
  decreased: boolean;
}

/**
 * Measure the unit's absolute fitness debt from its before/after violation IDENTITY
 * sets (baseline = HEAD). Counts are over distinct identities; `decreased` is the ac-9
 * gate (after < before). `removed` is the concrete count of identities cleared (never
 * negative — a debt INCREASE does not earn removal credit).
 */
export function assessUnitDebt(
  beforeIds: readonly string[],
  afterIds: readonly string[],
): UnitDebt {
  const before = new Set(beforeIds).size;
  const after = new Set(afterIds).size;
  const decreased = after < before;
  return { before, after, removed: decreased ? before - after : 0, decreased };
}

/** Auto-commit mode, mirroring behavior-lock / L2 semantics (§4.4). */
export type UnitAutoCommit = 'full' | 'diff-only' | 'none';

export interface UnitTidyInput {
  /** The unit string the user passed (e.g. `component:acg`) — used in messages. */
  unit: string;
  /** The resolved standing file set. */
  files: readonly string[];
  /** Whether the existing suite is green before tidy starts (G-R1 floor). */
  baselineGreen: boolean;
  /** Absolute unit debt before/after the refactor. */
  debt: { before: number; after: number };
  /** Behavior-preservation green = L1 met / unrefuted + medium+ L2 unrefuted. */
  behaviorGreen: boolean;
  /** N8: absent in this repo today → degrade-all to diff-only. */
  coverageProviderPresent?: boolean;
  /** Only consulted when a provider IS present: is the unit covered? */
  unitCovered?: boolean;
}

export interface UnitTidyDecision {
  unit: string;
  autoCommit: UnitAutoCommit;
  /** True only when the full §4.4 bar is reached → eligible for isolated-branch commit. */
  barMet: boolean;
  debtDecreased: boolean;
  behaviorGreen: boolean;
  /** NARROW residual questions for bar-miss portions (never a bulk diff). */
  residualQuestions: string[];
}

/**
 * Decide the unit's tidy outcome. Provider-presence-FIRST (N8): the bar collapses to
 * diff-only whenever no coverage provider is wired, regardless of per-unit coverage —
 * because a provider-less bar cannot witness behavior preservation and auto-committing
 * over it would reproduce the 검증 연극 §4.4 rejects.
 */
export function decideUnitTidy(input: UnitTidyInput): UnitTidyDecision {
  const debtDecreased = input.debt.after < input.debt.before;
  const residualQuestions: string[] = [];

  // (1) baseline red → tidy cannot start.
  if (!input.baselineGreen) {
    residualQuestions.push(
      `unit ${input.unit}: baseline suite is red — tidy cannot start on a non-green baseline (G-R1)`,
    );
    return {
      unit: input.unit,
      autoCommit: 'none',
      barMet: false,
      debtDecreased,
      behaviorGreen: input.behaviorGreen,
      residualQuestions,
    };
  }

  // (2) provider-presence-FIRST: no provider → degrade-ALL to diff-only (N8 / OBJ-04).
  if (!input.coverageProviderPresent) {
    residualQuestions.push(
      `unit ${input.unit}: no coverage provider wired (provider 0건) — behavior preservation cannot be witnessed at full bar; tidy accumulates as diff-only on the isolated branch for human PR review, not auto-committed (§4.4)`,
    );
    return {
      unit: input.unit,
      autoCommit: 'diff-only',
      barMet: false,
      debtDecreased,
      behaviorGreen: input.behaviorGreen,
      residualQuestions,
    };
  }

  // (3) provider present → per-unit branch on covered + behavior + debt.
  if (input.unitCovered !== true) {
    residualQuestions.push(
      `unit ${input.unit}: not covered by characterization — generate a characterization for the uncovered portion first, then retry (auto-tidy-ineligible until covered)`,
    );
    return {
      unit: input.unit,
      autoCommit: 'none',
      barMet: false,
      debtDecreased,
      behaviorGreen: input.behaviorGreen,
      residualQuestions,
    };
  }
  if (!input.behaviorGreen) {
    residualQuestions.push(
      `unit ${input.unit}: behavior preservation NOT green (L1/L2) — refactor is not auto-tidy-eligible (revert basis)`,
    );
    return {
      unit: input.unit,
      autoCommit: 'none',
      barMet: false,
      debtDecreased,
      behaviorGreen: input.behaviorGreen,
      residualQuestions,
    };
  }

  // Full bar: provider present + covered + behavior green. (Debt-decrease is the ac-9
  // value gate; an absolute-debt INCREASE is not a tidy success even under full bar.)
  if (!debtDecreased) {
    residualQuestions.push(
      `unit ${input.unit}: absolute fitness debt did not decrease (${input.debt.before}→${input.debt.after}) — not a tidy improvement`,
    );
    return {
      unit: input.unit,
      autoCommit: 'none',
      barMet: false,
      debtDecreased,
      behaviorGreen: input.behaviorGreen,
      residualQuestions,
    };
  }

  return {
    unit: input.unit,
    autoCommit: 'full',
    barMet: true,
    debtDecreased,
    behaviorGreen: input.behaviorGreen,
    residualQuestions: [],
  };
}
