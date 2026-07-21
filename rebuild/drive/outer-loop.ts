import { renameSync, writeFileSync } from 'node:fs';

import type {
  BoundaryEnvelope,
  DriveStepInput,
  HostAdapter,
} from '../seam/host-adapter';
import type { CodexDeps } from '../verify/codex';
import {
  isDrained,
  type QueueState,
  type QueueStateItem,
} from '../state/queue-state';
import { readLegibility } from '../state/legibility';
import { runEfficacy, type RunEfficacy } from '../state/net-efficacy';
import { park } from '../state/park';
import {
  captureIntentLock,
  checkIntentLock,
  type IntentLock,
} from '../state/intent-lock';
import { evaluateBackstop } from './backstop';
import { hashTestContent } from '../verify/red-first';
import {
  checkStructuralAnchor,
  type ObservedStructure,
  type StructuralExpectation,
} from '../verify/structural-anchor';
import { decideCompletionAuthority } from '../verify/completion-authority';
import { ORCHESTRATION_PROMPT } from './orchestration-prompt';

/**
 * The outer drive loop — the glue that runs the rebuild/ foundation autonomously
 * to queue-drain with zero human intervention (ac-1), composing the guardrails
 * the sibling nodes built rather than re-deriving them. Each round: read
 * legibility → one --resume drive step (mockable, timeout-guarded) → oracle-
 * integrity check (reject+revert if breached) → reconcile the boundary oracle →
 * atomic persist → net-efficacy + backstop update → drain check. The loop's own
 * hard turn cap (ABSOLUTE_ROUND_CEILING, ac-6) bounds it independently of the
 * progress heuristics so a churn-livelock can never spin forever.
 */

export type DriveOutcome =
  | 'drained'
  | 'parked'
  | 'ceiling'
  | 'oracle-violation'
  | 'timeout';

export interface DriveResult {
  outcome: DriveOutcome;
  rounds: number;
  state: QueueState;
  reasons: string[];
  efficacy: RunEfficacy[];
}

/** Low-level fs ops behind the atomic writer — injected so the temp+rename
 *  discipline (and torn-write recovery) is unit-testable without a real crash. */
export interface AtomicFs {
  writeFile(path: string, data: string): void;
  rename(from: string, to: string): void;
}

export const realAtomicFs: AtomicFs = {
  writeFile: (path, data) => writeFileSync(path, data),
  rename: (from, to) => renameSync(from, to),
};

/**
 * Persist queue.json atomically: write a sibling temp file, then rename it onto
 * the target. rename is atomic on POSIX, so a crash before the rename leaves the
 * previous good file untouched — never a torn/partial full-file rewrite.
 */
export function writeQueueStateAtomic(
  path: string,
  state: QueueState,
  fs: AtomicFs = realAtomicFs,
): void {
  const tmp = `${path}.tmp`;
  fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.rename(tmp, path);
}

export interface DriveDeps {
  readState(): QueueState;
  writeState(state: QueueState): void;
  readOracleContent(path: string): string | null;
  roundDiff(): string[];
  codex: CodexDeps;
  observedStructures?(): ObservedStructure[];
}

export interface DriveConfig {
  absoluteRoundCeiling: number;
  maxNoProgressRounds: number;
  timeoutMs: number;
  oraclePaths: string[];
  prompt?: string;
  structuralExpectations?: StructuralExpectation[];
}

export interface OracleIntegrityInput {
  touched: string[];
  oraclePaths: string[];
  capturedHashes: Record<string, string>;
  currentContent: Record<string, string | null>;
}

export interface OracleIntegrityResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Oracle-integrity gate (folds ac-2/ac-3/ac-5): a round may not touch or alter
 * the frozen oracle files (the frozen tests, completion gate, verify checker,
 * queue-state schema). BOTH a denylist (the round diff must not list an oracle
 * path) AND a hash-freeze (each oracle file's content must still hash to its
 * capture-window snapshot) are enforced. Pure and injectable — no real git.
 */
export function checkOracleIntegrity(
  input: OracleIntegrityInput,
): OracleIntegrityResult {
  const reasons: string[] = [];
  const oracleSet = new Set(input.oraclePaths);

  for (const path of input.touched) {
    if (oracleSet.has(path)) {
      reasons.push(`round diff touched frozen oracle file: ${path}`);
    }
  }

  for (const path of input.oraclePaths) {
    const current = input.currentContent[path];
    if (current === undefined || current === null) {
      reasons.push(`oracle file missing/deleted at check time: ${path}`);
      continue;
    }
    const captured = input.capturedHashes[path];
    if (captured === undefined) {
      reasons.push(`oracle file was not captured at the freeze window: ${path}`);
      continue;
    }
    if (hashTestContent(current) !== captured) {
      reasons.push(`oracle file content changed since capture (hash mismatch): ${path}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

// ---- internal helpers -------------------------------------------------------

function captureOracleHashes(
  paths: string[],
  read: (path: string) => string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of paths) {
    const content = read(path);
    if (content !== null) out[path] = hashTestContent(content);
  }
  return out;
}

function readOracleContents(
  paths: string[],
  read: (path: string) => string | null,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const path of paths) out[path] = read(path);
  return out;
}

/** Apply the boundary queue oracle onto the disk state: the boundary is the sole
 *  queue truth, so each item's exit is taken from it (undefined ⇒ open/null), and
 *  items the round newly surfaced are added (found scope is allowed). */
function reconcile(state: QueueState, boundary: BoundaryEnvelope): QueueState {
  const byId = new Map(boundary.queue.map((item) => [item.id, item] as const));
  const items: QueueStateItem[] = state.items.map((item) => {
    const b = byId.get(item.id);
    if (b === undefined) return item;
    byId.delete(item.id);
    return { ...item, exit: b.exit ?? null };
  });
  for (const b of byId.values()) {
    items.push({
      id: b.id,
      kind: b.kind,
      exit: b.exit ?? null,
      evidence_ref: null,
      disposition_note: null,
    });
  }
  return { ...state, items };
}

function bumpBackstop(
  state: QueueState,
  eff: RunEfficacy,
  turns: number,
): QueueState {
  const b = state.backstop;
  return {
    ...state,
    round: turns,
    backstop: {
      turns,
      no_progress_rounds: eff.netProgress ? 0 : b.no_progress_rounds + 1,
      queue_size_trend: [...b.queue_size_trend, eff.openAfter],
    },
  };
}

interface TimedResult<T> {
  timedOut: boolean;
  value?: T;
}

/** Race a promise against a wall-clock budget so a stalled subprocess can't hang
 *  the loop. On timeout the caller fails closed (treats the round as divergence). */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<TimedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimedResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  const race = await Promise.race([
    p.then((value): TimedResult<T> => ({ timedOut: false, value })),
    timeout,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return race;
}

function parkAndFinish(
  deps: DriveDeps,
  outcome: DriveOutcome,
  state: QueueState,
  rounds: number,
  reasons: string[],
  efficacy: RunEfficacy[],
  parkInput: { decision: string; doneSummary: string; resumeCondition: string },
): DriveResult {
  const parked = park(state, parkInput);
  const finalState = parked.parked ? parked.state : state;
  deps.writeState(finalState);
  return { outcome, rounds, state: finalState, reasons, efficacy };
}

export async function runDrive(
  host: HostAdapter,
  deps: DriveDeps,
  config: DriveConfig,
): Promise<DriveResult> {
  const prompt = config.prompt ?? ORCHESTRATION_PROMPT;

  // Freeze the oracle files at the capture-window (before any round runs).
  const capturedHashes = captureOracleHashes(
    config.oraclePaths,
    deps.readOracleContent,
  );

  let state = deps.readState();
  // Freeze the acceptance-criteria SET (intent-lock): the loop may never silently
  // shrink its own goal mid-run.
  const intentLock: IntentLock = captureIntentLock(
    state.acceptance_criteria.map((ac) => ac.id),
  );

  const efficacy: RunEfficacy[] = [];
  let rounds = 0;
  let prevSession: string | undefined;
  let lastTestGreen = false;

  while (!isDrained(state) && rounds < config.absoluteRoundCeiling) {
    const before = readLegibility(state);

    // One fresh/resumed drive step, timeout-guarded (--resume chain via sessionId).
    const input: DriveStepInput =
      prevSession !== undefined ? { prompt, resume: prevSession } : { prompt };
    const stepped = await withTimeout(host.driveStep(input), config.timeoutMs);

    if (stepped.timedOut || stepped.value === undefined) {
      const reason = `driveStep timed out after ${config.timeoutMs}ms — divergence, fail closed`;
      return parkAndFinish(deps, 'timeout', state, rounds, [reason], efficacy, {
        decision: reason,
        doneSummary: before.summary,
        resumeCondition: 'driveStep completes within the timeout budget; investigate the stall',
      });
    }

    const { sessionId, boundary } = stepped.value;
    prevSession = sessionId;

    // Oracle-integrity: reject BEFORE accepting the mutation. A breach reverts the
    // round (state left unchanged) and escapes.
    const oracle = checkOracleIntegrity({
      touched: deps.roundDiff(),
      oraclePaths: config.oraclePaths,
      capturedHashes,
      currentContent: readOracleContents(config.oraclePaths, deps.readOracleContent),
    });
    if (!oracle.ok) {
      return parkAndFinish(
        deps,
        'oracle-violation',
        state,
        rounds,
        oracle.reasons,
        efficacy,
        {
          decision: `oracle-integrity breach — ${oracle.reasons.join('; ')}`,
          doneSummary: before.summary,
          resumeCondition: 'frozen oracle files (tests / gate / verify / schema) restored intact',
        },
      );
    }

    // Accept the round: apply the boundary oracle, bump the round + backstop.
    state = reconcile(state, boundary);
    rounds += 1;

    const after = readLegibility(state);
    lastTestGreen = boundary.gate?.decision === 'pass';
    const eff = runEfficacy(before, after, lastTestGreen);
    efficacy.push(eff);
    state = bumpBackstop(state, eff, rounds);

    // Persist the accepted round atomically (temp + rename), never a direct rewrite.
    deps.writeState(state);

    // Intent-lock: the frozen AC set may not be reduced/changed/exempted mid-run.
    const lock = checkIntentLock(
      intentLock,
      state.acceptance_criteria.map((ac) => ac.id),
    );
    if (!lock.admissible) {
      return parkAndFinish(deps, 'parked', state, rounds, [lock.reason ?? 'intent-lock violation'], efficacy, {
        decision: `intent-lock violation — ${lock.reason ?? 'frozen AC set reduced'}`,
        doneSummary: after.summary,
        resumeCondition: 'restore the frozen acceptance-criteria set',
      });
    }

    // Negative backstop: divergence heuristics route to escape.
    const backstop = evaluateBackstop(state.backstop, {
      maxNoProgressRounds: config.maxNoProgressRounds,
    });
    if (backstop.tripped) {
      return parkAndFinish(deps, 'parked', state, rounds, backstop.reasons, efficacy, {
        decision: `backstop tripped — ${backstop.reasons.join('; ')}`,
        doneSummary: after.summary,
        resumeCondition: 'human review of the divergence reasons',
      });
    }
  }

  // Loop exited: either drained, or the absolute hard cap stopped a churn-livelock.
  const finalLeg = readLegibility(state);
  if (!isDrained(state)) {
    const reason = `ABSOLUTE_ROUND_CEILING ${config.absoluteRoundCeiling} reached without drain (churn-livelock hard stop)`;
    return parkAndFinish(deps, 'ceiling', state, rounds, [reason], efficacy, {
      decision: reason,
      doneSummary: finalLeg.summary,
      resumeCondition: 'human review of the churn-livelock',
    });
  }

  // Drained. Completion is gated by the external authority (maker≠checker) AND a
  // structural-anchor match — a self-graded green cannot declare completion.
  const authority = decideCompletionAuthority(
    {
      testExitCode: lastTestGreen ? 0 : 1,
      claim: `queue drained: ${finalLeg.summary}`,
      // Evidence must be self-contained for the independent checker (it reads the
      // evidence, not the claim): lead with the final disposition breakdown
      // (resolved/deferred/escaped/open) the checker needs, then the per-round trace.
      evidence:
        `final disposition — ${finalLeg.summary}. per-round: ` +
        (efficacy
          .map((e, i) => `round ${i}: open ${e.openBefore}->${e.openAfter} green=${e.testGreenAfter}`)
          .join('; ') || 'no rounds ran'),
    },
    deps.codex,
  );
  const anchor = checkStructuralAnchor(
    config.structuralExpectations ?? [],
    deps.observedStructures?.() ?? [],
  );

  if (!authority.complete || anchor.status === 'mismatch') {
    const reasons = [
      ...authority.reasons,
      ...(anchor.status === 'mismatch' ? anchor.reasons : []),
    ];
    return parkAndFinish(deps, 'parked', state, rounds, reasons, efficacy, {
      decision: `completion withheld — ${reasons.join('; ') || 'authority/anchor not satisfied'}`,
      doneSummary: finalLeg.summary,
      resumeCondition: 'external completion authority verifies and the structural anchor matches',
    });
  }

  deps.writeState(state);
  return { outcome: 'drained', rounds, state, reasons: [], efficacy };
}
