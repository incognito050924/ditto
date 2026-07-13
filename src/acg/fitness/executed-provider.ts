/**
 * Executed-mode evaluator engine (단계8, ADR-0004 Q4 / OBJ-18). mode=executed인
 * FitnessFunction은 deterministic처럼 `evaluator.spec`를 실행하지만, 테스트/e2e라
 * **flaky·비용**을 다뤄야 한다 — `evaluator.execution`(timeout_s/retries/flake_policy)을
 * 적용해 실제 실행하고 위반을 도출한다.
 *
 * 출력 계약은 deterministic과 동일: stdout의 비어있지 않은 각 라인 = (호출자가 정규화한)
 * 위반 식별자. exit code는 무시하고 timeout/spawn 실패만 "errored"로 본다(공통 계약 유지).
 * executed의 차이는 출력 형식이 아니라 flake/timeout/retry 정책이다.
 *
 * 비용이 큰 모드라 자동(stop) 트리거가 아니라 `ditto fitness run --execute` opt-in으로만
 * 돈다. 순수부(flake 판정)는 단위 테스트로, 실행부(spawn+timeout)는 deps 주입으로 검증한다.
 */
import { commandProvider } from './command-provider';
import type { EvaluatorProvider } from './fitness-runner';
import { injectedProvider } from './injected-provider';

export type FlakePolicy = 'quarantine' | 'fail' | 'retry';

/** 한 번의 executed 실행 결과. errored=timeout/spawn 실패(위반 판정 불가). */
export interface ExecutedRun {
  errored: boolean;
  reason?: string;
  /** stdout 비어있지 않은 라인들(errored면 무시). */
  violationIds: string[];
}

export interface ExecutedDeps {
  runOnce(
    spec: string,
    opts: { timeoutMs?: number; repoRoot: string; requiresCleanBuild?: boolean },
  ): Promise<ExecutedRun>;
}

/** 위반셋 시그니처(순서 무관 동일성). */
function signature(run: ExecutedRun): string {
  return JSON.stringify([...run.violationIds].sort());
}

/**
 * 재시도 결과들을 flake_policy로 한 판정으로 접는다(순수).
 *  - 모든 attempt가 errored(timeout/spawn) → skip(fail-closed; fabricated pass 금지).
 *  - non-errored가 모두 같은 위반셋 → 안정적, 그 셋 반환.
 *  - 불일치(flaky):
 *      quarantine → skip(차단 안 함, 격리 표시),
 *      retry      → 위반 가장 적은 attempt 채택(재시도가 일시 실패를 흡수),
 *      fail(기본) → 모든 attempt 위반의 합집합(엄격 — 한 번이라도 본 위반은 차단).
 */
export function decideExecutedOutcome(
  attempts: ExecutedRun[],
  flakePolicy: FlakePolicy,
): { skipped?: { reason: string }; violationIds: string[] } {
  const ok = attempts.filter((a) => !a.errored);
  if (ok.length === 0) {
    const reason = attempts[0]?.reason ?? 'unknown';
    return {
      skipped: { reason: `all ${attempts.length} executed attempt(s) errored: ${reason}` },
      violationIds: [],
    };
  }
  const signatures = new Set(ok.map(signature));
  if (signatures.size === 1) return { violationIds: (ok[0] as (typeof ok)[number]).violationIds };
  // flaky: non-errored attempts disagree.
  if (flakePolicy === 'quarantine') {
    return {
      skipped: {
        reason: `flaky executed result: ${ok.length} attempts disagreed → quarantined (not blocking)`,
      },
      violationIds: [],
    };
  }
  if (flakePolicy === 'retry') {
    const best = ok.reduce((m, a) => (a.violationIds.length < m.violationIds.length ? a : m));
    return { violationIds: best.violationIds };
  }
  // 'fail' (default): strict union — any violation seen in any attempt counts.
  return { violationIds: [...new Set(ok.flatMap((a) => a.violationIds))] };
}

/**
 * 실 실행: sh -c spec, stdout 라인=위반, timeout이면 errored. spawn 실패도 errored.
 * requiresCleanBuild=true면 non-zero exit를 "빌드/명령 실패"로 보아 errored(빈/부분 추출을
 * clean으로 오판하지 않게 fail-close). 부재/false면 기존 동작(exit code 무시, 하위호환).
 */
async function defaultRunOnce(
  spec: string,
  opts: { timeoutMs?: number; repoRoot: string; requiresCleanBuild?: boolean },
): Promise<ExecutedRun> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['sh', '-c', spec], {
      cwd: opts.repoRoot,
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    });
  } catch (err) {
    return { errored: true, reason: `spawn failed: ${String(err)}`, violationIds: [] };
  }
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, opts.timeoutMs)
    : undefined;
  try {
    const out = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    const exitCode = await proc.exited;
    if (timedOut) {
      return { errored: true, reason: `timeout after ${opts.timeoutMs}ms`, violationIds: [] };
    }
    if (opts.requiresCleanBuild && exitCode !== 0) {
      return {
        errored: true,
        reason: `clean build not proven: spec exited non-zero (${exitCode})`,
        violationIds: [],
      };
    }
    const violationIds = out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { errored: false, violationIds };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const realDeps: ExecutedDeps = { runOnce: defaultRunOnce };

/**
 * Executed-mode provider. mode=executed가 아니면 skip(이 provider 책임 밖). execution 정책의
 * retries(추가 시도)·timeout_s를 적용해 (1+retries)회 실행하고 decideExecutedOutcome으로 접는다.
 */
export function executedProvider(
  repoRoot: string,
  deps: ExecutedDeps = realDeps,
): EvaluatorProvider {
  return {
    evaluate: async (fn) => {
      if (fn.evaluator.mode !== 'executed') {
        return {
          skipped: {
            reason: `executedProvider only runs mode=executed (got ${fn.evaluator.mode})`,
          },
          violationIds: [],
        };
      }
      const exec = fn.evaluator.execution ?? {};
      const timeoutMs = exec.timeout_s ? exec.timeout_s * 1000 : undefined;
      const attemptsN = 1 + (exec.retries ?? 0);
      const flake: FlakePolicy = exec.flake_policy ?? 'fail';
      const requiresCleanBuild = exec.requires_clean_build;
      const runs: ExecutedRun[] = [];
      for (let i = 0; i < attemptsN; i++) {
        runs.push(
          await deps.runOnce(fn.evaluator.spec, {
            repoRoot,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(requiresCleanBuild !== undefined ? { requiresCleanBuild } : {}),
          }),
        );
      }
      return decideExecutedOutcome(runs, flake);
    },
  };
}

/**
 * 모드별 라우팅(직접 실행 경로): deterministic → commandProvider, executed → executedProvider,
 * llm_judged → injectedProvider(verdict 파일 있으면)/skip(LLM 판정은 ditto가 직접 못 돌림).
 * `ditto fitness run --execute`가 쓴다.
 */
export function executingProvider(repoRoot: string, verdictsPath?: string): EvaluatorProvider {
  const deterministic = commandProvider(repoRoot);
  const executed = executedProvider(repoRoot);
  const injected = verdictsPath ? injectedProvider(verdictsPath, repoRoot) : null;
  return {
    evaluate: async (fn, ctx) => {
      if (fn.evaluator.mode === 'deterministic') return deterministic.evaluate(fn, ctx);
      if (fn.evaluator.mode === 'executed') return executed.evaluate(fn, ctx);
      if (injected) return injected.evaluate(fn, ctx);
      return {
        skipped: {
          reason: 'llm_judged needs --verdicts (ditto does not run LLM judgment directly)',
        },
        violationIds: [],
      };
    },
  };
}
