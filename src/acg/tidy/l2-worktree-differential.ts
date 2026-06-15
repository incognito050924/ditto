/**
 * L2 STANDING-code worktree differential (ADR-0018 D1/D5, wi_260615t8o ac-2/ac-3) — the
 * provider that turns the effect-interception core into a behaviorGreen source for
 * `ditto refactor --scope`. The core (`effect-interception.ts`) records an effect trace
 * for an in-process function; standing code, however, needs (a) real INPUTS (which only
 * its characterization tests supply) and (b) two VERSIONS (OLD=HEAD, NEW=working tree).
 *
 * So this provider runs the unit's characterization tests in OLD (a HEAD worktree) and
 * NEW (the working tree) under an effect-interception PRELOAD, and compares two things:
 *   1. the test OUTCOME (a characterization test that passed on OLD but fails on NEW is a
 *      confirmed behavior change), and
 *   2. the observable EFFECT TRACE (the whitelisted channels — Bun.spawn*, child_process —
 *      the run drove, in order, with args).
 *
 * HONESTY / SAFETY (dialectic-10):
 *  - OBJ-B / D5: an EFFECT-BEARING unit whose OLD trace is EMPTY is "un-observed"
 *    (interception did not reach its effects — e.g. `node:fs` named imports are bound at
 *    import and cannot be patched), NOT "behavior preserved". It degrades to `unverified`
 *    (diff-only), never a false `full`.
 *  - All error directions bias toward NOT auto-committing: a false divergence reads as
 *    `refuted` → no commit (conservative), and an un-observed unit degrades. The dangerous
 *    direction (false `full`) is closed by D5. fail-open: any orchestration failure →
 *    `unverified`/diff-only, never a hard block (ac-3).
 *
 * ADR-0006: this is runtime instrumentation (a preload that patches global/CJS channels),
 * not static analysis — no TS compiler/AST.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type WorktreeHandle, createWorktreeForRun, removeRunWorktree } from '~/core/worktree';
import type { EffectCall } from './effect-interception';
import { compareTraces } from './effect-interception';
import type { L2DifferentialVerdict } from './l2-differential';

/**
 * Whitelisted effect channels detectable in source text (D5 effect-bearing test). These
 * are the channels the interception preload can actually patch at runtime: the `Bun.spawn*`
 * globals and `node:child_process`. `node:fs` named imports are deliberately EXCLUDED —
 * they bind the function at import and cannot be patched, so a unit that only uses them is
 * un-observable and must degrade (D5), not be treated as effect-traceable.
 */
const EFFECT_MARKERS: readonly RegExp[] = [
  /\bBun\.spawn(Sync)?\b/,
  /node:child_process/,
  /\bglobalThis\.fetch\b/,
];

/** Does the unit route effects through a PATCHABLE channel (so an empty trace = un-observed, D5)? */
export function isEffectBearing(sourceTexts: readonly string[]): boolean {
  return sourceTexts.some((src) => EFFECT_MARKERS.some((re) => re.test(src)));
}

/** One traced run of the unit's characterization tests: did they pass, and what effects ran. */
export interface TracedRun {
  /** Whether the test run exited green (characterization passed). */
  testsOk: boolean;
  /** Ordered observable effect trace (already path-normalized by the preload). */
  trace: EffectCall[];
}

/**
 * Classify the OLD↔NEW differential (pure). Order of decisions encodes the safety bias:
 *   1. OLD tests red → the characterization is invalid → unverified (can't witness on a
 *      red baseline), diff-only.
 *   2. NEW tests red (OLD green) → a pinned behavior broke → confirmed refutation, no commit.
 *   3. effect traces diverge → confirmed refutation, no commit.
 *   4. effect-bearing unit but OLD trace empty → D5 un-observed → unverified, diff-only.
 *   5. otherwise (outcomes agree, traces agree) → unrefuted → full-bar eligible.
 */
export function classifyWorktreeDifferential(
  oldRun: TracedRun,
  newRun: TracedRun,
  effectBearing: boolean,
): L2DifferentialVerdict {
  if (!oldRun.testsOk) {
    return {
      status: 'unverified',
      autoCommit: 'diff-only',
      reviewHighRisk: true,
      reason:
        'OLD (HEAD) characterization tests are red — cannot witness behavior preservation on an invalid baseline; degrade to diff-only (fail-open, not a block)',
    };
  }
  if (!newRun.testsOk) {
    return {
      status: 'refuted',
      autoCommit: 'none',
      reviewHighRisk: false,
      reason:
        'a characterization test that passed on OLD now fails on NEW — confirmed behavior change (revert basis)',
    };
  }
  const diff = compareTraces(oldRun.trace, newRun.trace);
  if (diff.refuted) {
    return {
      status: 'refuted',
      autoCommit: 'none',
      reviewHighRisk: false,
      reason: `OLD↔NEW effect trace diverged — confirmed regression (${diff.reason ?? 'trace mismatch'})`,
    };
  }
  if (effectBearing && oldRun.trace.length === 0) {
    return {
      status: 'unverified',
      autoCommit: 'diff-only',
      reviewHighRisk: true,
      reason:
        'unit is effect-bearing but interception observed ZERO effects (un-observed, not preserved) — e.g. node:fs named imports cannot be patched; degrade to diff-only (D5), never a false full',
    };
  }
  return {
    status: 'unrefuted',
    autoCommit: 'full',
    reviewHighRisk: false,
    reason:
      oldRun.trace.length > 0
        ? `OLD↔NEW test outcome and effect trace agreed (${oldRun.trace.length} effects; unrefuted — not a preservation proof, §4.3)`
        : 'OLD↔NEW test outcome agreed and the unit drove no whitelisted effects (unrefuted — not a preservation proof, §4.3)',
  };
}

/** What the provider needs to know to run the differential. */
export interface L2WorktreeInput {
  repoRoot: string;
  /** The unit's resolved source files (used for the D5 effect-bearing test). */
  unitFiles: readonly string[];
  /** The characterization test files that exercise the unit (the input source). */
  testPaths: readonly string[];
}

/** Injectable seams — the default impls shell out / touch git; tests pass mocks. */
export interface L2WorktreeDeps {
  createWorktree: (repoRoot: string, runId: string) => WorktreeHandle | Promise<WorktreeHandle>;
  removeWorktree: (repoRoot: string, relativePath: string) => void;
  /** Run the test set under interception in `cwd`, returning outcome + normalized trace. */
  runTraced: (
    cwd: string,
    testPaths: readonly string[],
    normalizeRoot: string,
  ) => TracedRun | Promise<TracedRun>;
  /** Read the unit's source files as text (for the effect-bearing test). */
  readUnitSources: (repoRoot: string, files: readonly string[]) => string[];
}

/** A stable-enough run id for the worktree (no Date.now/random in the hot path). */
function worktreeRunId(unitFiles: readonly string[]): string {
  let h = 0;
  for (const f of unitFiles) for (let i = 0; i < f.length; i++) h = (h * 31 + f.charCodeAt(i)) | 0;
  return `l2-${(h >>> 0).toString(36)}`;
}

const degraded = (reason: string): L2DifferentialVerdict => ({
  status: 'unverified',
  autoCommit: 'diff-only',
  reviewHighRisk: true,
  reason,
});

/**
 * Orchestrate the standing-code L2 differential: materialize OLD=HEAD as a worktree, run
 * the unit's tests under interception in OLD (worktree cwd) then NEW (repoRoot), classify,
 * and always tear the worktree down. Any failure degrades to diff-only (fail-open, ac-3).
 */
export async function runL2WorktreeDifferential(
  input: L2WorktreeInput,
  deps: L2WorktreeDeps,
): Promise<L2DifferentialVerdict> {
  const effectBearing = (() => {
    try {
      return isEffectBearing(deps.readUnitSources(input.repoRoot, input.unitFiles));
    } catch {
      return true; // unknown → treat as effect-bearing so an empty trace degrades (safe)
    }
  })();

  let handle: WorktreeHandle | undefined;
  try {
    handle = await deps.createWorktree(input.repoRoot, worktreeRunId(input.unitFiles));
  } catch (err) {
    return degraded(
      `L2 degraded: could not create HEAD worktree (${err instanceof Error ? err.message : String(err)}) — diff-only (fail-open)`,
    );
  }

  try {
    const oldRun = await deps.runTraced(handle.absolutePath, input.testPaths, handle.absolutePath);
    const newRun = await deps.runTraced(input.repoRoot, input.testPaths, input.repoRoot);
    return classifyWorktreeDifferential(oldRun, newRun, effectBearing);
  } catch (err) {
    return degraded(
      `L2 degraded: traced run failed (${err instanceof Error ? err.message : String(err)}) — diff-only (fail-open)`,
    );
  } finally {
    try {
      deps.removeWorktree(input.repoRoot, handle.relativePath);
    } catch {
      // worktree teardown failure is non-fatal to the verdict (cleanup is best-effort).
    }
  }
}

/** Repo-relative preload path, resolved absolutely against the working-tree repo root. */
const PRELOAD_REL = 'scripts/l2-effect-preload.ts';

/**
 * Default traced run: spawn `bun test <paths> --preload <preload>` in `cwd` with the
 * interception preload wired to a throwaway trace file, then read back the normalized
 * JSONL trace. `testsOk` = exit 0. Absent/garbled trace lines are skipped (best-effort) —
 * the differential degrades safely on a thin trace rather than throwing.
 */
export function defaultRunTraced(
  repoRoot: string,
  cwd: string,
  testPaths: readonly string[],
  normalizeRoot: string,
): TracedRun {
  const traceDir = mkdtempSync(join(tmpdir(), 'ditto-l2-'));
  const traceOut = join(traceDir, 'trace.jsonl');
  try {
    const preload = join(repoRoot, PRELOAD_REL);
    const r = Bun.spawnSync(['bun', 'test', ...testPaths, '--preload', preload], {
      cwd,
      stdout: 'ignore',
      stderr: 'ignore',
      env: { ...process.env, DITTO_L2_TRACE_OUT: traceOut, DITTO_L2_NORM_ROOT: normalizeRoot },
    });
    const testsOk = r.exitCode === 0;
    let trace: EffectCall[] = [];
    try {
      trace = readFileSync(traceOut, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as EffectCall];
          } catch {
            return [];
          }
        });
    } catch {
      trace = []; // no trace file (no whitelisted effects ran) → empty trace.
    }
    return { testsOk, trace };
  } finally {
    rmSync(traceDir, { recursive: true, force: true });
  }
}

/**
 * The production seams: real git worktree, real traced `bun test`, real source reads.
 * `repoRoot` is the WORKING TREE — the preload is resolved against it (the OLD worktree
 * sits at HEAD and may not contain an uncommitted preload), while tests run in each `cwd`.
 */
export function defaultL2WorktreeDeps(repoRoot: string): L2WorktreeDeps {
  return {
    createWorktree: createWorktreeForRun,
    removeWorktree: removeRunWorktree,
    runTraced: (cwd, testPaths, normalizeRoot) =>
      defaultRunTraced(repoRoot, cwd, testPaths, normalizeRoot),
    readUnitSources: (root, files) =>
      files.map((f) => {
        try {
          return readFileSync(join(root, f), 'utf8');
        } catch {
          return '';
        }
      }),
  };
}
