/**
 * ② L2 old↔new differential — a NEW framework: a RELATIVE
 * oracle that asserts `old(x) ≡ new(x)` on the same input set. It does NOT need the
 * "correct" output — only whether old and new AGREE — so it detects the regressions a
 * refactor introduces (over-fitting, wrong internal call). No record/replay/intercept
 * harness existed in `src/` before this (§4.2 — 신규 프레임워크, OBJ-05).
 *
 * Two variants (§4.2):
 *  - PURE  : pure functions → return-value equality.
 *  - TRACE : side-effecting code → record the observable effect TRACE (external-call
 *            args + order, I/O, return, thrown exceptions) during a green baseline run,
 *            then replay `new` on the same inputs and compare the trace.
 *
 * Honest limits (§4.3): trace PASS = UNREFUTED (not proof); trace FAIL = CONFIRMED
 * refutation. When there is NO intercept seam (or genuinely non-reproducible
 * nondeterminism) the differential is intrinsically unverifiable → it DEGRADES to an
 * `unverified` verdict flagged Review high-risk / auto-tidy-INELIGIBLE. It NEVER hard
 * blocks (fail-open — intent out_of_scope; dialectic-8 OBJ-02).
 *
 * Input generation (§4.2): literal seed inputs alone miss over-fitting, so inputs are
 * `seeds ∪ generated`. No property/fuzz lib is wired in this repo, so generation is a
 * minimal DETERMINISTIC seeded expansion (reproducible — no unseeded randomness).
 */

/** A divergence between old and new at a specific reproducing input. */
export interface L2Counterexample<I> {
  /** The reproducing input — the basis to revert the tidy item (§4.2 형태). */
  input: I;
  /** Human-readable description of how old and new diverged. */
  divergence: string;
}

/**
 * `refuted`     — old and new diverged on some input → confirmed regression.
 * `unrefuted`   — agreed on every input checked (NOT a proof of preservation; §4.3).
 * `unverified`  — no seam / non-recordable effects → degraded, fail-open (§4.3).
 */
export type L2Status = 'refuted' | 'unrefuted' | 'unverified';

/** Reuses behavior-lock's auto-commit gating semantics (§4.4). */
export type L2AutoCommit = 'full' | 'diff-only' | 'none';

export interface L2DifferentialVerdict<I = unknown> {
  status: L2Status;
  autoCommit: L2AutoCommit;
  /**
   * True when the change cannot be machine-verified and must go to human Review as
   * high-risk (auto-tidy-INELIGIBLE) RATHER THAN block (§4.3 / §4.4 bar 미달).
   */
  reviewHighRisk: boolean;
  reason: string;
  /** Present only when status === 'refuted'. */
  counterexample?: L2Counterexample<I>;
}

/**
 * The intercept SEAM (§4.3). A side-effecting unit makes its external calls through
 * this recorder; the differential records the call args + order during the old run and
 * replays new on the same input to compare the effect TRACE. Absence of such a seam is
 * what degrades L2 to `unverified` (ac-7).
 */
export interface EffectRecorder {
  /** Record one observable external effect (its name + args, in call order). */
  call(name: string, ...args: unknown[]): void;
}

/** One recorded effect: an external call name with its serialized args. */
interface RecordedEffect {
  name: string;
  args: unknown[];
}

/** PURE variant: compare return values of two pure functions. */
export interface L2PureInput<I> {
  kind: 'pure';
  old: (x: I) => unknown;
  new: (x: I) => unknown;
  /** Seed corpus (existing test inputs). */
  seeds: I[];
  /** Deterministic expansion from a seed → extra inputs (no unseeded randomness). */
  generate?: (seed: I) => I[];
  /** Upper bound on inputs to check, proportional to risk (§4.2 — N bounded). */
  inputCount?: number;
}

/** Structural equality used to compare return values / recorded effects. */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** seeds ∪ generated, de-duplicated by structural identity, capped at inputCount. */
function buildInputs<I>(seeds: I[], generate: ((seed: I) => I[]) | undefined, cap: number): I[] {
  const out: I[] = [];
  const seen = new Set<string>();
  const push = (x: I) => {
    const key = JSON.stringify(x);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(x);
  };
  for (const s of seeds) push(s);
  if (generate) {
    for (const s of seeds) {
      for (const g of generate(s)) {
        if (out.length >= cap) break;
        push(g);
      }
    }
  }
  return out.slice(0, cap);
}

function runPure<I>(input: L2PureInput<I>): L2DifferentialVerdict<I> {
  const inputs = buildInputs(input.seeds, input.generate, input.inputCount ?? 100);
  for (const x of inputs) {
    const oldOut = input.old(x);
    const newOut = input.new(x);
    if (!deepEqual(oldOut, newOut)) {
      return {
        status: 'refuted',
        autoCommit: 'none',
        reviewHighRisk: false,
        reason: 'old↔new return values diverged — confirmed regression (revert the tidy item)',
        counterexample: {
          input: x,
          divergence: `old returned ${JSON.stringify(oldOut)} but new returned ${JSON.stringify(newOut)}`,
        },
      };
    }
  }
  return {
    status: 'unrefuted',
    autoCommit: 'full',
    reviewHighRisk: false,
    reason: `old↔new agreed on all ${inputs.length} inputs (unrefuted — not a preservation proof; §4.3)`,
  };
}

/**
 * TRACE variant: a side-effecting unit records its observable effects through an
 * injected {@link EffectRecorder}. The differential records old's effect trace, then
 * replays new on the same input and compares the trace (call names + args + order, and
 * the return value / thrown exception). This is regression DETECTION, not a preservation
 * proof (§4.3 — trace pass = unrefuted, trace fail = confirmed refutation).
 */
export interface L2TraceInput<I> {
  kind: 'trace';
  old: (x: I, rec: EffectRecorder) => unknown;
  new: (x: I, rec: EffectRecorder) => unknown;
  seeds: I[];
  generate?: (seed: I) => I[];
  inputCount?: number;
  /**
   * Declares that the side-effecting unit has NO intercept seam to record effects, or
   * its effects are non-recordable (genuine non-reproducible nondeterminism — §4.3).
   * When true the differential is intrinsically unverifiable → degrades to `unverified`
   * + Review high-risk RATHER THAN block (fail-open).
   */
  noSeam?: boolean;
}

/** Run one side-effecting unit, capturing its effect trace + return / thrown outcome. */
function recordTrace<I>(
  unit: (x: I, rec: EffectRecorder) => unknown,
  x: I,
): { effects: RecordedEffect[]; outcome: unknown } {
  const effects: RecordedEffect[] = [];
  const rec: EffectRecorder = { call: (name, ...args) => effects.push({ name, args }) };
  try {
    return { effects, outcome: { return: unit(x, rec) } };
  } catch (err) {
    return { effects, outcome: { threw: err instanceof Error ? err.message : String(err) } };
  }
}

function runTrace<I>(input: L2TraceInput<I>): L2DifferentialVerdict<I> {
  if (input.noSeam) {
    return {
      status: 'unverified',
      autoCommit: 'diff-only',
      reviewHighRisk: true,
      reason:
        'no intercept seam to record effects (or non-recordable nondeterminism) — L2 is intrinsically unverifiable; degrade to unverified + flag Review high-risk (auto-tidy-ineligible), do NOT block (§4.3)',
    };
  }
  const inputs = buildInputs(input.seeds, input.generate, input.inputCount ?? 100);
  for (const x of inputs) {
    const oldRun = recordTrace(input.old, x);
    const newRun = recordTrace(input.new, x);
    if (!deepEqual(oldRun.effects, newRun.effects)) {
      return {
        status: 'refuted',
        autoCommit: 'none',
        reviewHighRisk: false,
        reason: 'old↔new effect trace diverged — confirmed regression (revert the tidy item)',
        counterexample: {
          input: x,
          divergence: `old effects ${JSON.stringify(oldRun.effects)} but new effects ${JSON.stringify(newRun.effects)}`,
        },
      };
    }
    if (!deepEqual(oldRun.outcome, newRun.outcome)) {
      return {
        status: 'refuted',
        autoCommit: 'none',
        reviewHighRisk: false,
        reason: 'old↔new outcome (return/throw) diverged — confirmed regression',
        counterexample: {
          input: x,
          divergence: `old outcome ${JSON.stringify(oldRun.outcome)} but new outcome ${JSON.stringify(newRun.outcome)}`,
        },
      };
    }
  }
  return {
    status: 'unrefuted',
    autoCommit: 'full',
    reviewHighRisk: false,
    reason: `old↔new effect trace agreed on all ${inputs.length} inputs (unrefuted — not a preservation proof; §4.3)`,
  };
}

export type L2DifferentialInput<I = unknown> = L2PureInput<I> | L2TraceInput<I>;

/**
 * Run the L2 differential for one tidy item.
 *
 * - pure  refuted   → counterexample + no auto-commit (revert basis).
 * - trace refuted   → effect-trace counterexample + no auto-commit.
 * - unrefuted       → full bar eligible (old↔new agreed on every input checked).
 */
export function runL2Differential<I>(input: L2DifferentialInput<I>): L2DifferentialVerdict<I> {
  return input.kind === 'trace' ? runTrace(input) : runPure(input);
}
