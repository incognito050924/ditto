/**
 * Hook one-cycle measurement (standalone harness, NOT part of the bun test suite).
 *
 * rebuild side: `rebuild/hook/stop-hook.ts` executed as a real subprocess
 * (import.meta.main path), because the hook cycle includes spawn + stdin parse +
 * test-runner spawn + state read/parse + decision + state WRITE-BACK
 * (stop-hook.ts writes state.last_stop_hook every run). Therefore:
 *  - each iteration runs against a DISPOSABLE tmpdir copy of the fixture
 *    (the in-memory fixture is serialized fresh; nothing shared is mutated);
 *  - VEHICLE_WORKSPACE is always explicit; VEHICLE_TEST_CMD is a deterministic
 *    stub (fixed exit-0 / exit-1 scripts) — a separate real-runner mode measures
 *    the same cycle with the actual `bun test rebuild/` so runner cost falls out
 *    as the difference;
 *  - an OUTER timeout is imposed (runTestRunner itself has none);
 *  - the child env is sanitized: CLAUDE_PROJECT_DIR, DITTO_SKIP_HOOKS, GIT_DIR,
 *    GIT_WORK_TREE, GIT_INDEX_FILE are removed.
 *
 * src side: the old stopHandler is NEVER executed as a process — it has live
 * side effects (ledger writes, fitness auto-run). Its hook-cycle counterpart is
 * honestly LIMITED to "pure judgment core + the ledger-parse cost the old gate
 * incurs" (schema-parse of the work-item + autopilot JSON documents, then the
 * production-shape assembly); the limitation is stamped into the result.
 *
 * Exit classification is a strict 3-bucket: allow(0) / block(2) /
 * error(anything else: other codes, null exit, signal, timeout). Raw exit and
 * signal are recorded — never folded through an `exitCode ?? 1` style collapse
 * (the stop-hook's own runTestRunner folds that way internally; the HARNESS
 * classification must not).
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseQueueState } from '../../rebuild/state/queue-state';
import { autopilot } from '../../src/schemas/autopilot';
import { workItem } from '../../src/schemas/work-item';
import type { FixturePair } from './fixtures';
import { srcAssemble } from './measure-core';
import { type StatSummary, summarize } from './stats';

export type ExitBucket = 'allow' | 'block' | 'error';

export interface HookRunOutcome {
  bucket: ExitBucket;
  raw_exit: number | null;
  signal: string | null;
  timed_out: boolean;
  duration_ns: number;
  stderr_bytes: number;
  /** Positive signal: the hook completed its full cycle (last_stop_hook written back). */
  last_stop_hook_recorded: boolean;
}

export interface HookHarnessPaths {
  repoRoot: string;
  scratchRoot: string; // harness-owned tmp root (stubs live here)
  stubExit0: string;
  stubExit1: string;
}

const SANITIZED_ENV_KEYS = [
  'CLAUDE_PROJECT_DIR',
  'DITTO_SKIP_HOOKS',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
] as const;

export function setupHookHarness(repoRoot: string): HookHarnessPaths {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'measure-stop-gate-'));
  const stubExit0 = join(scratchRoot, 'stub-exit0.sh');
  const stubExit1 = join(scratchRoot, 'stub-exit1.sh');
  writeFileSync(stubExit0, '#!/bin/sh\nexit 0\n');
  writeFileSync(stubExit1, '#!/bin/sh\nexit 1\n');
  chmodSync(stubExit0, 0o755);
  chmodSync(stubExit1, 0o755);
  return { repoRoot, scratchRoot, stubExit0, stubExit1 };
}

export function teardownHookHarness(paths: HookHarnessPaths): void {
  rmSync(paths.scratchRoot, { recursive: true, force: true });
}

function sanitizedEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if ((SANITIZED_ENV_KEYS as readonly string[]).includes(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

/**
 * Run one hook cycle against a disposable tmpdir copy of the pair's queue state.
 * `testCmd` decides the runner: stub exit-0/exit-1 or the real suite command.
 */
export function runHookOnce(
  pair: FixturePair,
  paths: HookHarnessPaths,
  opts: { testCmd: string; stopHookActive: boolean; timeoutMs: number },
): HookRunOutcome {
  const ws = mkdtempSync(join(paths.scratchRoot, 'ws-'));
  try {
    mkdirSync(join(ws, 'state'), { recursive: true });
    const statePath = join(ws, 'state', 'queue.json');
    writeFileSync(statePath, `${JSON.stringify(pair.rebuild.state, null, 2)}\n`);

    const hookPath = join(paths.repoRoot, 'rebuild', 'hook', 'stop-hook.ts');
    const stdin = JSON.stringify({ stop_hook_active: opts.stopHookActive });
    const t0 = Bun.nanoseconds();
    const res = spawnSync('bun', [hookPath], {
      cwd: paths.repoRoot,
      env: sanitizedEnv({ VEHICLE_WORKSPACE: ws, VEHICLE_TEST_CMD: opts.testCmd }),
      input: stdin,
      timeout: opts.timeoutMs,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const t1 = Bun.nanoseconds();

    const timedOut =
      res.error !== undefined && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    const rawExit = res.status; // number | null — NEVER folded (no `?? 1` collapse)
    const signal = res.signal;
    const bucket: ExitBucket =
      timedOut || signal !== null || rawExit === null
        ? 'error'
        : rawExit === 0
          ? 'allow'
          : rawExit === 2
            ? 'block'
            : 'error';

    // Positive signal: the hook records every completed run into last_stop_hook.
    let lastStopHookRecorded = false;
    try {
      const after = parseQueueState(readFileSync(statePath, 'utf8'));
      lastStopHookRecorded = after.last_stop_hook !== null;
    } catch {
      lastStopHookRecorded = false;
    }

    return {
      bucket,
      raw_exit: rawExit,
      signal,
      timed_out: timedOut,
      duration_ns: t1 - t0,
      stderr_bytes: (res.stderr ?? '').length,
      last_stop_hook_recorded: lastStopHookRecorded,
    };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

export interface HookTimingResult {
  stats: StatSummary;
  valid_n: number;
  invalid_runs: HookRunOutcome[];
  bucket_counts: Record<ExitBucket, number>;
}

/**
 * Timed hook-cycle series. A run is VALID (counts into stats) only when it lands
 * in `expectBucket` AND the write-back positive signal is present — a silent
 * exit 0 without a completed cycle must never be aggregated as an "allow".
 */
export function measureHookCycle(
  pair: FixturePair,
  paths: HookHarnessPaths,
  opts: {
    testCmd: string;
    stopHookActive: boolean;
    timeoutMs: number;
    samples: number;
    warmup: number;
    expectBucket: ExitBucket;
  },
): HookTimingResult {
  const buckets: Record<ExitBucket, number> = { allow: 0, block: 0, error: 0 };
  const invalid: HookRunOutcome[] = [];
  const durations: number[] = [];
  let coldFirst = 0;
  const warmupSamples: number[] = [];

  const total = 1 + opts.warmup + opts.samples;
  for (let i = 0; i < total; i++) {
    const out = runHookOnce(pair, paths, opts);
    buckets[out.bucket]++;
    const valid = out.bucket === opts.expectBucket && out.last_stop_hook_recorded;
    if (!valid) invalid.push(out);
    if (i === 0) coldFirst = out.duration_ns;
    else if (i <= opts.warmup) warmupSamples.push(out.duration_ns);
    else if (valid) durations.push(out.duration_ns);
  }

  if (durations.length === 0) {
    throw new Error(
      `hook-cycle measurement produced ZERO valid runs (expected bucket=${opts.expectBucket}); invalid=${JSON.stringify(invalid.slice(0, 3))}`,
    );
  }
  return {
    stats: summarize(durations, { innerReps: 1, coldFirstSample: coldFirst, warmupSamples }),
    valid_n: durations.length,
    invalid_runs: invalid,
    bucket_counts: buckets,
  };
}

export function runnerCostNs(realStats: StatSummary, stubStats: StatSummary): number {
  return realStats.median - stubStats.median;
}

/* ------------------------------ src hook-cycle proxy ------------------------------ */

export const SRC_PROXY_LIMITATION =
  'src stopHandler is NOT executed as a process (it has live side effects: ledger writes + fitness auto-run). ' +
  'The src hook-cycle figure is honestly LIMITED to: schema-parse of the work-item + autopilot JSON ledgers ' +
  '(the artifact-parse cost the old Stop gate incurs per invocation) + the pure production-shape judgment core ' +
  '(assembleCompletionFromGraph = deriveAcVerdicts + buildCompletion + floor projections). It excludes process spawn, ' +
  'session-pointer/work-item store reads, fitness, and ledger write-back — so it is a LOWER BOUND, not a full cycle.';

/**
 * The src-side proxy callable: parse the two ledger documents through their
 * schemas (fail-closed, as the old gate does via readArtifact) then run the
 * production-shape judgment. Serialization happens once, outside.
 */
export function srcHookProxyCallable(pair: FixturePair): () => 'allow' | 'block' {
  const graphJson = JSON.stringify(pair.src.graph);
  const wiJson = JSON.stringify(pair.src.workItem);
  return () => {
    const graph = autopilot.parse(JSON.parse(graphJson));
    const wi = workItem.parse(JSON.parse(wiJson));
    const completion = srcAssemble({ ...pair, src: { graph, workItem: wi } });
    return completion.final_verdict === 'pass' ? 'allow' : 'block';
  };
}
