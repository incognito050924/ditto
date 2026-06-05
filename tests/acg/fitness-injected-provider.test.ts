import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FitnessContext } from '~/acg/fitness/fitness-runner';
import { compositeProvider, injectedProvider } from '~/acg/fitness/injected-provider';
import { type AcgFitnessFunction, acgFitnessFunction } from '~/schemas/acg-fitness-function';

const ctx: FitnessContext = {
  trigger: 'per_change',
  riskKnown: true,
  producedAt: '2026-06-05T00:00:00Z',
};

function fn(overrides: Record<string, unknown> = {}): AcgFitnessFunction {
  return acgFitnessFunction.parse({
    schema_version: '0.1.0',
    kind: 'acg.fitness-function.v1',
    produced_by: 'agent',
    produced_at: '2026-06-05T00:00:00Z',
    id: 'ff-judge',
    statement: 'no banned imports per the judge',
    fitness_kind: 'architectural',
    evaluator: {
      mode: 'llm_judged',
      spec: 'judge prompt',
      reproducibility: { model_version: 'claude-opus-4-8' },
    },
    cadence: { per_change: true, periodic: 'none' },
    on_violation: 'block',
    ...overrides,
  });
}

async function withVerdicts(
  content: string,
  body: (path: string, repoRoot: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-injfit-'));
  try {
    const path = join(dir, 'fitness-verdicts.json');
    await writeFile(path, content, 'utf8');
    await body(path, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const verdictFile = (entries: unknown[]) =>
  JSON.stringify({
    schema_version: '0.1.0',
    kind: 'acg.fitness-verdict.v1',
    produced_by: 'agent',
    produced_at: '2026-06-05T00:00:00Z',
    verdicts: entries,
  });

describe('injectedProvider — 에이전트 주입형 verdict 소비', () => {
  test('유효 verdict pass → 위반 없음', async () => {
    await withVerdicts(
      verdictFile([
        {
          function_id: 'ff-judge',
          mode: 'llm_judged',
          verdict: 'pass',
          reproducibility: { model_version: 'claude-opus-4-8' },
        },
      ]),
      async (path, root) => {
        const res = await injectedProvider(path, root).evaluate(fn(), ctx);
        expect(res.skipped).toBeUndefined();
        expect(res.violationIds).toEqual([]);
      },
    );
  });

  test('유효 verdict fail → violation_ids 반환', async () => {
    await withVerdicts(
      verdictFile([
        {
          function_id: 'ff-judge',
          mode: 'llm_judged',
          verdict: 'fail',
          violation_ids: ['v1', 'v2'],
          reproducibility: { model_version: 'claude-opus-4-8' },
        },
      ]),
      async (path, root) => {
        const res = await injectedProvider(path, root).evaluate(fn(), ctx);
        expect(res.skipped).toBeUndefined();
        expect(res.violationIds).toEqual(['v1', 'v2']);
      },
    );
  });

  test('fail이지만 violation_ids 누락 → function_id 단일 위반', async () => {
    await withVerdicts(
      verdictFile([
        {
          function_id: 'ff-judge',
          mode: 'llm_judged',
          verdict: 'fail',
          reproducibility: { model_version: 'claude-opus-4-8' },
        },
      ]),
      async (path, root) => {
        const res = await injectedProvider(path, root).evaluate(fn(), ctx);
        expect(res.violationIds).toEqual(['ff-judge']);
      },
    );
  });

  test('파일 미존재 → skip+reason (fabricated pass 금지)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-injfit-'));
    try {
      const res = await injectedProvider(join(dir, 'missing.json'), dir).evaluate(fn(), ctx);
      expect(res.skipped).toBeDefined();
      expect(res.skipped?.reason).toContain('missing/invalid');
      expect(res.violationIds).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('해당 fn verdict 없음 → skip+reason', async () => {
    await withVerdicts(
      verdictFile([
        {
          function_id: 'ff-other',
          mode: 'llm_judged',
          verdict: 'pass',
          reproducibility: { model_version: 'claude-opus-4-8' },
        },
      ]),
      async (path, root) => {
        const res = await injectedProvider(path, root).evaluate(fn(), ctx);
        expect(res.skipped).toBeDefined();
        expect(res.skipped?.reason).toContain('no injected verdict');
      },
    );
  });

  test('llm_judged인데 reproducibility 누락 → 파일 거부 → 전 fn skip (fail-closed)', async () => {
    await withVerdicts(
      verdictFile([{ function_id: 'ff-judge', mode: 'llm_judged', verdict: 'pass' }]),
      async (path, root) => {
        const res = await injectedProvider(path, root).evaluate(fn(), ctx);
        expect(res.skipped).toBeDefined();
        expect(res.skipped?.reason).toContain('missing/invalid');
      },
    );
  });

  test('executed인데 evidence_ref 누락 → skip+reason (fail-closed)', async () => {
    const executedFn = fn({
      id: 'ff-exec',
      evaluator: { mode: 'executed', spec: 'e2e', execution: { selection: 'per_change' } },
    });
    await withVerdicts(
      verdictFile([{ function_id: 'ff-exec', mode: 'executed', verdict: 'pass' }]),
      async (path, root) => {
        const res = await injectedProvider(path, root).evaluate(executedFn, ctx);
        expect(res.skipped).toBeDefined();
        expect(res.skipped?.reason).toContain('evidence_ref');
      },
    );
  });

  test('executed + evidence_ref 존재 → pass', async () => {
    const executedFn = fn({
      id: 'ff-exec',
      evaluator: { mode: 'executed', spec: 'e2e', execution: { selection: 'per_change' } },
    });
    await withVerdicts(
      verdictFile([
        {
          function_id: 'ff-exec',
          mode: 'executed',
          verdict: 'pass',
          evidence_ref: '.ditto/runs/x/report.json',
        },
      ]),
      async (path, root) => {
        const res = await injectedProvider(path, root).evaluate(executedFn, ctx);
        expect(res.skipped).toBeUndefined();
        expect(res.violationIds).toEqual([]);
      },
    );
  });
});

describe('compositeProvider — 모드별 라우팅', () => {
  test('deterministic은 verdict 무관하게 commandProvider로 평가', async () => {
    const detFn = fn({
      id: 'ff-det',
      evaluator: { mode: 'deterministic', spec: 'echo det-violation' },
    });
    await withVerdicts(verdictFile([]), async (path, root) => {
      const res = await compositeProvider(root, path).evaluate(detFn, ctx);
      expect(res.skipped).toBeUndefined();
      expect(res.violationIds).toEqual(['det-violation']);
    });
  });

  test('llm_judged는 injectedProvider로 라우팅', async () => {
    await withVerdicts(
      verdictFile([
        {
          function_id: 'ff-judge',
          mode: 'llm_judged',
          verdict: 'fail',
          violation_ids: ['j1'],
          reproducibility: { model_version: 'claude-opus-4-8' },
        },
      ]),
      async (path, root) => {
        const res = await compositeProvider(root, path).evaluate(fn(), ctx);
        expect(res.violationIds).toEqual(['j1']);
      },
    );
  });
});
