import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type IclCompileEnv, compileIcl } from '~/acg/icl';

// WU-3 acceptance: the ICL → ChangeContract/FitnessFunction compiler
// (30-intent-change-dsl §3 mappings) emits Zod-valid ACG artifacts (D2 SoT)
// from a single .icl source. Targets A/C are out of scope (D6).

const env: IclCompileEnv = {
  work_item_id: 'wi_abcd1234',
  produced_by: 'agent',
  produced_at: '2026-06-03T00:00:00Z',
  judge_model_version: 'claude-opus-4-8',
};

const boxwoodSource = readFileSync(join(import.meta.dir, 'fixtures', 'retry-policy.icl'), 'utf-8');

const intentHeader = (body: string) => `intent "t" {\n  purpose: "p"\n${body}\n}`;

describe('compileIcl — boxwood fixture (30 §5)', () => {
  const result = compileIcl(boxwoodSource, env);

  test('compiles ok', () => {
    expect(result.ok).toBe(true);
  });

  test('ChangeContract: scope mappings, notes, risk/decision, invariants, acceptance', () => {
    if (!result.ok) throw new Error('expected ok');
    const cc = result.changeContract;

    expect(cc.kind).toBe('acg.change-contract.v1');
    expect(cc.work_item_id).toBe('wi_abcd1234');
    expect(cc.purpose).toBe('고정 3회 재시도를 1s/2s/4s 지수 백오프로 변경한다');

    // allowed_scope: glob passthrough; `as "관련 테스트"` → note
    expect(cc.allowed_scope).toEqual([
      { kind: 'glob', ref: 'automation-engine/**/runtime/**' },
      {
        kind: 'glob',
        ref: 'automation-engine/**/test/**/RetryPolicy*',
        note: '관련 테스트',
      },
    ]);

    // forbidden_scope: surface → public_surface, layer/symbol passthrough,
    // `# "메시지 계약 불변"` → note
    expect(cc.forbidden_scope).toEqual([
      { kind: 'layer', ref: 'kafka-adapter', note: '메시지 계약 불변' },
      { kind: 'public_surface', ref: 'external-client task contract' },
      { kind: 'symbol', ref: 'TenantContext', note: '테넌트 격리 불변' },
    ]);

    // risk medium + decision present (else Zod superRefine would fail)
    expect(cc.risk_default).toBe('medium');
    expect(cc.decision_ref).toBe('ADR-automation-0007');

    // invariants: promote → promotable
    expect(cc.invariants).toEqual([
      { statement: 'external-client가 받는 태스크 페이로드 형태는 동일하다', promotable: false },
      { statement: '재시도 중에도 tenant 격리가 유지된다', promotable: true },
    ]);

    // acceptance (2) with evidence_kind
    expect(cc.acceptance).toEqual([
      { criterion: '재시도 간격이 1s,2s,4s 지수 백오프를 따른다', evidence_kind: 'test' },
      { criterion: '기존 RetryPolicy 단위 테스트가 통과한다', evidence_kind: 'test' },
    ]);
  });

  test('FitnessFunction: judge → llm_judged with reproducibility OBJECT', () => {
    if (!result.ok) throw new Error('expected ok');
    expect(result.fitnessFunctions).toHaveLength(1);
    const ff = result.fitnessFunctions[0];
    if (!ff) throw new Error('expected fitness function');

    expect(ff.kind).toBe('acg.fitness-function.v1');
    expect(ff.id).toBe('tenant 격리 불변');
    expect(ff.fitness_kind).toBe('semantic');
    expect(ff.statement).toBe('재시도 경로에서 TenantContext가 항상 전파된다');
    expect(ff.source_change).toBe('wi_abcd1234');
    expect(ff.on_violation).toBe('warn');
    expect(ff.cadence).toEqual({ per_change: true, periodic: 'none' });

    expect(ff.evaluator.mode).toBe('llm_judged');
    // spec is the verbatim judge prompt from the ICL source
    expect(ff.evaluator.spec).toBe('재시도 핸들러 diff에서 TenantContext 전파가 누락되지 않았는가');
    // reproducibility is an OBJECT (not a string)
    expect(ff.evaluator.reproducibility).toEqual({
      model_version: 'claude-opus-4-8',
      votes: 3,
      tie_break: 'fail_closed',
      input_fixing: '변경 diff 전체',
    });
  });

  test('promote invariant present with a fitness block → no warning', () => {
    if (!result.ok) throw new Error('expected ok');
    expect(result.warnings).toBeUndefined();
  });
});

describe('compileIcl — mapping cases', () => {
  test('surface → public_surface', () => {
    const src = intentHeader(
      `  allow { surface "api v1" }\n  forbid { path "x" }\n  accept { "ok" by test }`,
    );
    const r = compileIcl(src, env);
    if (!r.ok) throw new Error('expected ok');
    expect(r.changeContract.allowed_scope[0]?.kind).toBe('public_surface');
  });

  test('cmd → deterministic, spec = command string', () => {
    const src = `${intentHeader(`  allow { path "x" }\n  forbid { path "y" }\n  accept { "ok" by test }`)}\nfitness "f1" {\n  statement: "s"\n  kind: dependency\n  check: cmd "bun test"\n  when: per_change\n  on_violation: block\n}`;
    const r = compileIcl(src, env);
    if (!r.ok) throw new Error('expected ok');
    expect(r.fitnessFunctions[0]?.evaluator.mode).toBe('deterministic');
    expect(r.fitnessFunctions[0]?.evaluator.spec).toBe('bun test');
    expect(r.fitnessFunctions[0]?.evaluator.reproducibility).toBeUndefined();
  });

  test('query → deterministic', () => {
    const src = `${intentHeader(`  allow { path "x" }\n  forbid { path "y" }\n  accept { "ok" by test }`)}\nfitness "f1" {\n  statement: "s"\n  kind: architectural\n  check: query "import * from x"\n  when: periodic(weekly)\n  on_violation: warn\n}`;
    const r = compileIcl(src, env);
    if (!r.ok) throw new Error('expected ok');
    expect(r.fitnessFunctions[0]?.evaluator.mode).toBe('deterministic');
    expect(r.fitnessFunctions[0]?.cadence).toEqual({ per_change: false, periodic: 'weekly' });
  });

  test('judge → llm_judged with reproducibility', () => {
    const src = `${intentHeader(`  allow { path "x" }\n  forbid { path "y" }\n  accept { "ok" by test }`)}\nfitness "f1" {\n  statement: "s"\n  kind: semantic\n  check: judge "is it safe"\n  when: both(on_release)\n  on_violation: track\n}`;
    const r = compileIcl(src, env);
    if (!r.ok) throw new Error('expected ok');
    expect(r.fitnessFunctions[0]?.evaluator.mode).toBe('llm_judged');
    expect(r.fitnessFunctions[0]?.evaluator.reproducibility?.model_version).toBe('claude-opus-4-8');
    expect(r.fitnessFunctions[0]?.cadence).toEqual({ per_change: true, periodic: 'on_release' });
  });
});

describe('compileIcl — static-check negatives', () => {
  test('empty forbid → static rule 1 error', () => {
    const src = intentHeader(`  allow { path "x" }\n  forbid { }\n  accept { "ok" by test }`);
    const r = compileIcl(src, env);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.some((e) => e.kind === 'static' && e.rule === 1)).toBe(true);
  });

  test('allow ∩ forbid overlap → static rule 2 error', () => {
    const src = intentHeader(
      `  allow { path "src/x.ts" }\n  forbid { path "src/x.ts" }\n  accept { "ok" by test }`,
    );
    const r = compileIcl(src, env);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.some((e) => e.kind === 'static' && e.rule === 2)).toBe(true);
  });

  test('empty accept → static rule 3 error', () => {
    const src = intentHeader(`  allow { path "x" }\n  forbid { path "y" }\n  accept { }`);
    const r = compileIcl(src, env);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.some((e) => e.kind === 'static' && e.rule === 3)).toBe(true);
  });

  test('promote without fitness → warning (rule 4), still ok', () => {
    const src = intentHeader(
      `  allow { path "x" }\n  forbid { path "y" }\n  invariant { "inv" promote }\n  accept { "ok" by test }`,
    );
    const r = compileIcl(src, env);
    if (!r.ok) throw new Error('expected ok');
    expect(r.warnings?.some((w) => w.kind === 'static' && w.rule === 4)).toBe(true);
  });
});

describe('compileIcl — schema negatives (Zod superRefine)', () => {
  test('risk medium without decision → schema error on decision_ref', () => {
    const src = intentHeader(
      `  allow { path "x" }\n  forbid { path "y" }\n  accept { "ok" by test }\n  meta { risk: medium }`,
    );
    const r = compileIcl(src, env);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.some((e) => e.kind === 'schema' && e.path === 'decision_ref')).toBe(true);
  });
});

describe('compileIcl — parse negatives', () => {
  test('malformed first token → single parse error', () => {
    const r = compileIcl('not_a_program {', env);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.kind).toBe('parse');
  });
});
