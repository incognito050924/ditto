import { describe, expect, test } from 'bun:test';
import {
  type ExecutedDeps,
  type ExecutedRun,
  decideExecutedOutcome,
  executedProvider,
  executingProvider,
} from '~/acg/fitness/executed-provider';
import type { FitnessContext } from '~/acg/fitness/fitness-runner';
import { type AcgFitnessFunction, acgFitnessFunction } from '~/schemas/acg-fitness-function';

const CTX: FitnessContext = {
  trigger: 'per_change',
  changeRef: 'wi_aaaaaaaa',
  riskKnown: true,
  producedAt: '2026-06-05T00:00:00.000Z',
};

const fn = (evaluator: Record<string, unknown>): AcgFitnessFunction =>
  acgFitnessFunction.parse({
    schema_version: '0.1.0',
    kind: 'acg.fitness-function.v1',
    produced_by: 'agent',
    produced_at: '2026-06-05T00:00:00.000Z',
    id: 'ff-x',
    statement: 'keep x',
    fitness_kind: 'performance',
    evaluator,
    cadence: { per_change: true, periodic: 'none' },
    on_violation: 'block',
  });

const ran = (violationIds: string[]): ExecutedRun => ({ errored: false, violationIds });
const err = (reason: string): ExecutedRun => ({ errored: true, reason, violationIds: [] });

// ── 순수 flake 판정 ──────────────────────────────────────────────────────────
describe('decideExecutedOutcome', () => {
  test('모든 attempt errored → skip(fail-closed)', () => {
    const r = decideExecutedOutcome(
      [err('timeout after 1000ms'), err('timeout after 1000ms')],
      'fail',
    );
    expect(r.skipped?.reason).toContain('errored');
    expect(r.violationIds).toEqual([]);
  });

  test('non-errored가 모두 같은 위반셋 → stable 반환(순서 무관)', () => {
    const r = decideExecutedOutcome([ran(['a', 'b']), ran(['b', 'a']), err('x')], 'fail');
    expect(r.skipped).toBeUndefined();
    expect(r.violationIds).toEqual(['a', 'b']);
  });

  test('flaky + quarantine → skip(격리, 차단 안 함)', () => {
    const r = decideExecutedOutcome([ran([]), ran(['a'])], 'quarantine');
    expect(r.skipped?.reason).toContain('quarantined');
    expect(r.violationIds).toEqual([]);
  });

  test('flaky + retry → 위반 가장 적은 attempt 채택', () => {
    const r = decideExecutedOutcome([ran(['a', 'b']), ran([]), ran(['a'])], 'retry');
    expect(r.violationIds).toEqual([]); // 빈 셋(회복된 실행)
  });

  test('flaky + fail → 합집합(엄격, 차단)', () => {
    const r = decideExecutedOutcome([ran(['a']), ran(['b'])], 'fail');
    expect([...r.violationIds].sort()).toEqual(['a', 'b']);
  });
});

// ── provider (spawn 주입) ────────────────────────────────────────────────────
function recordingDeps(results: ExecutedRun[]): { deps: ExecutedDeps; calls: number } {
  const state = { calls: 0 };
  return {
    deps: {
      runOnce: async () => {
        const r = results[Math.min(state.calls, results.length - 1)];
        state.calls++;
        return r;
      },
    },
    get calls() {
      return state.calls;
    },
  };
}

describe('executedProvider (deps 주입)', () => {
  test('mode!=executed면 skip(이 provider 책임 밖)', async () => {
    const { deps } = recordingDeps([ran([])]);
    const r = await executedProvider('/r', deps).evaluate(
      fn({ mode: 'deterministic', spec: 'x' }),
      CTX,
    );
    expect(r.skipped?.reason).toContain('only runs mode=executed');
  });

  test('retries=2 → runOnce 1+2=3회, flake_policy 적용', async () => {
    const rec = recordingDeps([ran(['a']), ran([]), ran([])]);
    const r = await executedProvider('/r', rec.deps).evaluate(
      fn({ mode: 'executed', spec: 'test.sh', execution: { retries: 2, flake_policy: 'retry' } }),
      CTX,
    );
    expect(rec.calls).toBe(3);
    expect(r.violationIds).toEqual([]); // retry → 최소 위반(빈 셋)
  });

  test('retries 미지정 → 1회만, 기본 flake=fail', async () => {
    const rec = recordingDeps([ran(['v1'])]);
    const r = await executedProvider('/r', rec.deps).evaluate(
      fn({ mode: 'executed', spec: 's' }),
      CTX,
    );
    expect(rec.calls).toBe(1);
    expect(r.violationIds).toEqual(['v1']);
  });
});

// ── 실 spawn ─────────────────────────────────────────────────────────────────
describe('executedProvider (real spawn)', () => {
  test('stdout 비어있지 않은 라인 = 위반 식별자', async () => {
    const r = await executedProvider(process.cwd()).evaluate(
      fn({ mode: 'executed', spec: "printf 'v1\\nv2\\n'" }),
      CTX,
    );
    expect(r.violationIds).toEqual(['v1', 'v2']);
  });

  test('빈 stdout → 위반 없음(pass)', async () => {
    const r = await executedProvider(process.cwd()).evaluate(
      fn({ mode: 'executed', spec: 'true' }),
      CTX,
    );
    expect(r.violationIds).toEqual([]);
  });

  test('timeout → errored → skip(fail-closed)', async () => {
    const r = await executedProvider(process.cwd()).evaluate(
      fn({ mode: 'executed', spec: 'sleep 5', execution: { timeout_s: 1 } }),
      CTX,
    );
    expect(r.skipped?.reason).toContain('errored');
  }, 8000);
});

// ── requires_clean_build 가드 (G5) ──────────────────────────────────────────
describe('requires_clean_build fail-closed 가드 (real spawn)', () => {
  test('(a) requires_clean_build=true + non-zero exit + 빈 stdout → errored→skip(pass·clean 아님)', async () => {
    const r = await executedProvider(process.cwd()).evaluate(
      fn({ mode: 'executed', spec: 'exit 1', execution: { requires_clean_build: true } }),
      CTX,
    );
    expect(r.skipped?.reason).toContain('errored');
    expect(r.violationIds).toEqual([]);
  });

  test('(b) requires_clean_build=true + exit 0 + 위반 라인 → 정상 위반 파싱', async () => {
    const r = await executedProvider(process.cwd()).evaluate(
      fn({
        mode: 'executed',
        spec: "printf 'v1\\nv2\\n'",
        execution: { requires_clean_build: true },
      }),
      CTX,
    );
    expect(r.skipped).toBeUndefined();
    expect(r.violationIds).toEqual(['v1', 'v2']);
  });

  test('(c) requires_clean_build 부재 + non-zero exit → 기존 동작(clean으로 처리, 하위호환)', async () => {
    const r = await executedProvider(process.cwd()).evaluate(
      fn({ mode: 'executed', spec: 'exit 1' }),
      CTX,
    );
    expect(r.skipped).toBeUndefined();
    expect(r.violationIds).toEqual([]); // exit code 무시 — 기존 동작
  });
});

describe('executingProvider — 모드별 라우팅(real spawn)', () => {
  test('deterministic→command, executed→executed, llm_judged(verdicts 없음)→skip', async () => {
    const p = executingProvider(process.cwd());
    const det = await p.evaluate(fn({ mode: 'deterministic', spec: "printf 'd1\\n'" }), CTX);
    expect(det.violationIds).toEqual(['d1']);
    const exe = await p.evaluate(fn({ mode: 'executed', spec: "printf 'e1\\n'" }), CTX);
    expect(exe.violationIds).toEqual(['e1']);
    const llm = await p.evaluate(
      fn({
        mode: 'llm_judged',
        spec: 'judge prompt',
        reproducibility: { model_version: 'claude-opus-4-8' },
      }),
      CTX,
    );
    expect(llm.skipped?.reason).toContain('--verdicts');
  });
});
