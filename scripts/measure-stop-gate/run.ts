#!/usr/bin/env bun
/**
 * Standalone measurement harness for the two completion-gate paths — run with
 * `bun run scripts/measure-stop-gate/run.ts`. Deliberately NOT named *.test.ts
 * (must never be collected by `bun test`); its own validity is proven by the
 * built-in self-checks below, not by suite membership.
 *
 * Measures, side by side, on isomorphic fixture pairs (fixtures.ts):
 *  - pure-core latency: rebuild `evaluateStopGate` vs src production-shape
 *    `assembleCompletionFromGraph` (= deriveAcVerdicts + buildCompletion +
 *    floors) and the bare derive+build pair;
 *  - hook one-cycle latency (rebuild stop-hook subprocess; stub runner and real
 *    runner, cost separated by difference) and the honestly-limited src proxy;
 *  - verdict agreement/mismatch table across the fixture classes, causes
 *    classified from STRUCTURAL fields only.
 *
 * Isolation contract (self-enforced, violation = abnormal exit):
 *  - never touches real `.ditto/local` or the working tree: all mutation happens
 *    in disposable tmpdirs; `git status --porcelain` is compared before/after
 *    and any delta (other than an explicitly requested --out file) aborts;
 *  - raw results go to stdout by default, or to the path given via --out.
 *
 * Flags:
 *   --out <path>      write the JSON result to a file instead of stdout
 *   --n <int>         core samples per class (default 30; floor 30 enforced)
 *   --inner <int>     inner reps per core sample (default 20)
 *   --hook-n <int>    hook-cycle samples per timed series (default 30)
 *   --real-n <int>    real-runner hook samples (default 3)
 *   --skip-real       skip the real-runner series (stub-only)
 *   --self-check      run fixture/pair/stats/control checks only, no timing
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { queueState } from '../../rebuild/state/queue-state';
import { autopilot } from '../../src/schemas/autopilot';
import { type FixturePair, buildFixtures, checkPairConsistency } from './fixtures';
import {
  DEFAULT_CORE_TIMING,
  divergenceCause,
  measureCallable,
  rebuildDecide,
  rebuildDecideStratified,
  rebuildFactors,
  srcAssemble,
  srcDeriveBuild,
  srcFactors,
  validateRebuildDecision,
  validateSrcCompletion,
} from './measure-core';
import {
  type ExitBucket,
  type HookHarnessPaths,
  SRC_PROXY_LIMITATION,
  measureHookCycle,
  runHookOnce,
  runnerCostNs,
  setupHookHarness,
  srcHookProxyCallable,
  teardownHookHarness,
} from './measure-hook';
import { statsSelfCheck } from './stats';

const REPO_ROOT = resolve(join(import.meta.dir, '..', '..'));
const TARGET_FILES = [
  'rebuild/hook/stop-gate.ts',
  'rebuild/hook/stop-hook.ts',
  'src/core/autopilot-complete.ts',
  'src/hooks/stop.ts',
] as const;

/* ----------------------------------- cli args ----------------------------------- */

interface Args {
  out?: string;
  n: number;
  inner: number;
  hookN: number;
  realN: number;
  skipReal: boolean;
  selfCheckOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    n: 30,
    inner: 20,
    hookN: 30,
    realN: 3,
    skipReal: false,
    selfCheckOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === '--out') args.out = next();
    else if (a === '--n') args.n = Number(next());
    else if (a === '--inner') args.inner = Number(next());
    else if (a === '--hook-n') args.hookN = Number(next());
    else if (a === '--real-n') args.realN = Number(next());
    else if (a === '--skip-real') args.skipReal = true;
    else if (a === '--self-check') args.selfCheckOnly = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (args.n < 30) throw new Error('--n must be >= 30 (measurement contract: N >= 30)');
  return args;
}

/* --------------------------------- self-checks ---------------------------------- */

function gitPorcelain(): string {
  const res = spawnSync('git', ['status', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`git status --porcelain failed: ${res.stderr}`);
  return res.stdout;
}

/** Drop porcelain lines attributable to the explicitly requested --out target. */
function filterOutTarget(porcelain: string, outPath: string | undefined): string {
  if (!outPath) return porcelain;
  const abs = isAbsolute(outPath) ? outPath : resolve(process.cwd(), outPath);
  const rel = relative(REPO_ROOT, abs);
  if (rel.startsWith('..')) return porcelain; // out target lives outside the repo
  return porcelain
    .split('\n')
    .filter((line) => {
      if (line.trim() === '') return false;
      const entry = line.slice(3).replace(/\/$/, '');
      return !(rel === entry || rel.startsWith(`${entry}/`));
    })
    .join('\n');
}

interface ControlCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * Gate-actually-works controls (critical): a deliberately-broken sibling of the
 * green fixture MUST block on each path. Without this, a silently-inert gate
 * would aggregate every run as "allow" and fake the whole baseline.
 */
function runControlChecks(
  pairs: FixturePair[],
  hookPaths: HookHarnessPaths | null,
): ControlCheck[] {
  const checks: ControlCheck[] = [];
  const green = pairs.find((p) => p.class_id === 'all-green');
  const pending = pairs.find((p) => p.class_id === 'pending-residual');
  if (!green || !pending) throw new Error('control fixtures missing');

  // rebuild core control: green state + injected pending item must BLOCK.
  const ctlState = queueState.parse({
    ...JSON.parse(JSON.stringify(green.rebuild.state)),
    items: [
      ...JSON.parse(JSON.stringify(green.rebuild.state.items)),
      {
        id: 'q-ctl',
        kind: 'in-scope-residual',
        exit: null,
        evidence_ref: null,
        disposition_note: null,
      },
    ],
  });
  const ctlPair: FixturePair = { ...green, rebuild: { ...green.rebuild, state: ctlState } };
  const ctlDecision = rebuildDecide(ctlPair);
  checks.push({
    name: 'rebuild-core-control-blocks',
    passed: ctlDecision.exitCode === 2 && ctlDecision.reasons.length > 0,
    detail: `injected pending item -> exit ${ctlDecision.exitCode}, reasons=${ctlDecision.reasons.length}`,
  });

  // src core control: green graph with the impl node's evidence stripped must be non-pass.
  const strippedGraph = autopilot.parse(
    JSON.parse(
      JSON.stringify({
        ...green.src.graph,
        nodes: green.src.graph.nodes.map((n) =>
          n.kind === 'implement' ? { ...n, evidence_refs: [] } : n,
        ),
      }),
    ),
  );
  const ctlCompletion = srcAssemble({ ...green, src: { ...green.src, graph: strippedGraph } });
  checks.push({
    name: 'src-core-control-non-pass',
    passed: ctlCompletion.final_verdict !== 'pass',
    detail: `evidence stripped -> final_verdict=${ctlCompletion.final_verdict}`,
  });

  // hook-cycle control: pending fixture through the real subprocess must exit 2.
  if (hookPaths) {
    const out = runHookOnce(pending, hookPaths, {
      testCmd: `sh ${hookPaths.stubExit0}`,
      stopHookActive: false,
      timeoutMs: 30_000,
    });
    checks.push({
      name: 'hook-cycle-control-blocks',
      passed: out.bucket === 'block' && out.stderr_bytes > 0 && out.last_stop_hook_recorded,
      detail: `pending fixture -> bucket=${out.bucket}, raw_exit=${out.raw_exit}, stderr_bytes=${out.stderr_bytes}, write_back=${out.last_stop_hook_recorded}`,
    });
  }

  return checks;
}

/* ------------------------------------- main -------------------------------------- */

function sha256File(relPath: string): string {
  return createHash('sha256')
    .update(readFileSync(join(REPO_ROOT, relPath)))
    .digest('hex');
}

function commitSha(): string {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : 'unknown';
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const porcelainBefore = gitPorcelain();

  const fatal: string[] = [];
  const pairs = buildFixtures(); // schema-parse SoT: throws on any drift

  // pair consistency (fatal)
  for (const pair of pairs) fatal.push(...checkPairConsistency(pair));
  // stats index rules (fatal)
  fatal.push(...statsSelfCheck());

  const hookPaths = setupHookHarness(REPO_ROOT);
  let result: Record<string, unknown>;
  try {
    const controls = runControlChecks(pairs, hookPaths);
    for (const c of controls) {
      if (!c.passed) fatal.push(`control check failed: ${c.name} (${c.detail})`);
    }
    if (fatal.length > 0) {
      process.stderr.write(`SELF-CHECK FATAL:\n${fatal.map((f) => `  - ${f}`).join('\n')}\n`);
      return 4;
    }

    if (args.selfCheckOnly) {
      result = {
        mode: 'self-check',
        ok: true,
        pair_consistency: 'ok',
        stats_rules: 'ok',
        control_checks: controls,
      };
    } else {
      result = measureAll(pairs, hookPaths, args, controls);
    }
  } finally {
    teardownHookHarness(hookPaths);
  }

  // isolation self-check: working tree must be byte-identical (minus --out target)
  const porcelainAfter = gitPorcelain();
  const beforeF = filterOutTarget(porcelainBefore, args.out);
  const afterF = filterOutTarget(porcelainAfter, args.out);
  if (beforeF !== afterF) {
    process.stderr.write(
      `ISOLATION VIOLATION: git status --porcelain changed across the run.\n--- before ---\n${beforeF}\n--- after ---\n${afterF}\n`,
    );
    return 3;
  }
  (result as { self_check?: unknown }).self_check = {
    ...((result as { self_check?: Record<string, unknown> }).self_check ?? {}),
    git_porcelain_unchanged: true,
  };

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) writeFileSync(args.out, json);
  else process.stdout.write(json);
  return 0;
}

function measureAll(
  pairs: FixturePair[],
  hookPaths: HookHarnessPaths,
  args: Args,
  controls: ControlCheck[],
): Record<string, unknown> {
  const coreCfg = { ...DEFAULT_CORE_TIMING, samples: args.n, innerReps: args.inner };

  /* core latency per class */
  const coreLatency: Record<string, unknown> = {};
  const validN: Record<string, Record<string, number>> = {};
  for (const pair of pairs) {
    const reb = measureCallable(() => rebuildDecide(pair), validateRebuildDecision(pair), coreCfg);
    const asm = measureCallable(() => srcAssemble(pair), validateSrcCompletion(pair), coreCfg);
    const bare = measureCallable(() => srcDeriveBuild(pair), validateSrcCompletion(pair), coreCfg);
    coreLatency[pair.class_id] = {
      rebuild_evaluateStopGate: reb.stats,
      src_assembleCompletionFromGraph: asm.stats,
      src_deriveAcVerdicts_buildCompletion_bare: bare.stats,
    };
    validN[pair.class_id] = {
      rebuild: reb.valid_n,
      src_assemble: asm.valid_n,
      src_derive_build_bare: bare.valid_n,
    };
  }

  /* verdict table: core paths (deterministic) + hook cycle confirmation */
  const verdictRows: unknown[] = [];
  const expectationDeviations: string[] = [];
  for (const pair of pairs) {
    const dFalse = rebuildDecideStratified(pair, false);
    const dTrue = rebuildDecideStratified(pair, true);
    const rFactors = rebuildFactors(pair, dFalse);
    const completion = srcAssemble(pair);
    const sFactors = srcFactors(pair, completion);

    const stub = pair.rebuild.testExitCode === 0 ? hookPaths.stubExit0 : hookPaths.stubExit1;
    const hookBucket = (active: boolean): { bucket: ExitBucket; raw_exit: number | null } => {
      const out = runHookOnce(pair, hookPaths, {
        testCmd: `sh ${stub}`,
        stopHookActive: active,
        timeoutMs: 30_000,
      });
      return { bucket: out.bucket, raw_exit: out.raw_exit };
    };
    const hookFalse = hookBucket(false);
    const hookTrue = hookBucket(true);

    const match = rFactors.verdict === sFactors.verdict;
    const cause = divergenceCause(rFactors, sFactors);

    if (rFactors.verdict !== (pair.expected.rebuild_allows ? 'allow' : 'block')) {
      expectationDeviations.push(
        `${pair.class_id}: rebuild expected ${pair.expected.rebuild_allows ? 'allow' : 'block'}, got ${rFactors.verdict}`,
      );
    }
    if (sFactors.verdict !== (pair.expected.src_allows ? 'allow' : 'block')) {
      expectationDeviations.push(
        `${pair.class_id}: src expected ${pair.expected.src_allows ? 'allow' : 'block'}, got ${sFactors.verdict}`,
      );
    }

    verdictRows.push({
      class_id: pair.class_id,
      description: pair.description,
      ...(pair.asymmetry_note ? { asymmetry_note: pair.asymmetry_note } : {}),
      rebuild_core: rFactors,
      // design stratification: rebuild keeps its verdict under stop_hook_active
      // (repeatBlock flag only) — recorded per class for transparency.
      rebuild_core_stop_hook_active: {
        exit_unchanged: dFalse.exitCode === dTrue.exitCode,
        repeat_block_flag: dTrue.repeatBlock,
      },
      src_core: sFactors,
      hook_cycle: {
        stop_hook_active_false: hookFalse,
        stop_hook_active_true: hookTrue,
      },
      match,
      divergence_expected: pair.expected.divergence_expected,
      ...(cause ? { divergence_cause_structural: cause } : {}),
    });
  }

  /* hook-cycle timing */
  const green = pairs.find((p) => p.class_id === 'all-green') as FixturePair;
  const pending = pairs.find((p) => p.class_id === 'pending-residual') as FixturePair;
  const hookCommon = { stopHookActive: false, timeoutMs: 30_000, warmup: 2 };
  const stubAllow = measureHookCycle(green, hookPaths, {
    ...hookCommon,
    testCmd: `sh ${hookPaths.stubExit0}`,
    samples: args.hookN,
    expectBucket: 'allow',
  });
  const stubBlock = measureHookCycle(pending, hookPaths, {
    ...hookCommon,
    testCmd: `sh ${hookPaths.stubExit0}`,
    samples: args.hookN,
    expectBucket: 'block',
  });
  let realAllow: ReturnType<typeof measureHookCycle> | null = null;
  if (!args.skipReal) {
    realAllow = measureHookCycle(green, hookPaths, {
      stopHookActive: false,
      timeoutMs: 300_000,
      warmup: 1,
      testCmd: `cd ${REPO_ROOT} && bun test rebuild/`,
      samples: args.realN,
      expectBucket: 'allow',
    });
  }

  /* src hook-cycle proxy (honestly limited; limitation stamped) */
  const proxyFn = srcHookProxyCallable(green);
  const proxy = measureCallable(
    proxyFn,
    (v) => (v === 'allow' ? null : `expected allow on all-green proxy, got ${v}`),
    coreCfg,
  );

  return {
    harness: {
      name: 'measure-stop-gate',
      generated_at: new Date().toISOString(),
      commit_sha: commitSha(),
      bun_version: Bun.version,
      target_file_hashes: Object.fromEntries(TARGET_FILES.map((f) => [f, sha256File(f)])),
      config: {
        core_samples: args.n,
        core_inner_reps: args.inner,
        core_warmup_batches: coreCfg.warmupBatches,
        hook_samples: args.hookN,
        real_runner_samples: args.skipReal ? 0 : args.realN,
      },
      env_sanitized_keys: [
        'CLAUDE_PROJECT_DIR',
        'DITTO_SKIP_HOOKS',
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_INDEX_FILE',
      ],
    },
    self_check: {
      pair_consistency: 'ok',
      stats_rules: 'ok',
      control_checks: controls,
    },
    fixtures: pairs.map((p) => ({
      class_id: p.class_id,
      description: p.description,
      ...(p.asymmetry_note ? { asymmetry_note: p.asymmetry_note } : {}),
      expected: p.expected,
    })),
    core_latency: coreLatency,
    core_valid_n: validN,
    hook_cycle: {
      rebuild: {
        stub_runner_allow_path: { ...stubAllow, invalid_runs: stubAllow.invalid_runs },
        stub_runner_block_path: { ...stubBlock, invalid_runs: stubBlock.invalid_runs },
        ...(realAllow
          ? {
              real_runner_allow_path: realAllow,
              runner_cost_ns_median_diff: runnerCostNs(realAllow.stats, stubAllow.stats),
            }
          : { real_runner_allow_path: 'skipped (--skip-real)' }),
        exit_bucket_rule:
          'allow = raw exit 0; block = raw exit 2; error = any other exit, null exit, signal, or outer timeout (raw exit + signal recorded, never folded via `?? 1`)',
      },
      src_proxy: {
        stats: proxy.stats,
        valid_n: proxy.valid_n,
        limitation: SRC_PROXY_LIMITATION,
      },
    },
    verdict_table: {
      allow_rule: {
        rebuild: 'evaluateStopGate exitCode === 0',
        src: 'assembled completion final_verdict === "pass"',
      },
      rows: verdictRows,
      stop_hook_active_design_divergence: {
        label: 'design-divergence (NOT a misjudgment; excluded from match/mismatch counting)',
        rebuild:
          'evaluateStopGate keeps blocking under stop_hook_active — repeatBlock only flags the repeat (rebuild/hook/stop-gate.ts)',
        src: 'stopHandler returns exit 0 immediately when raw.stop_hook_active === true (src/hooks/stop.ts)',
      },
    },
    expectation_deviations: expectationDeviations,
  };
}

process.exit(main());
