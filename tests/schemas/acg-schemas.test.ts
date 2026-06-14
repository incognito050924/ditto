import { describe, expect, test } from 'bun:test';
import { acgArchitectureSpec } from '~/schemas/acg-architecture-spec';
import { acgAssuranceSnapshot } from '~/schemas/acg-assurance-snapshot';
import { acgChangeContract } from '~/schemas/acg-change-contract';
import { acgFitnessFunction } from '~/schemas/acg-fitness-function';
import { acgImpactGraph } from '~/schemas/acg-impact-graph';
import { acgJourneyRun } from '~/schemas/acg-journey-run';
import { acgJourneySpec } from '~/schemas/acg-journey-spec';
import { acgReviewGraph } from '~/schemas/acg-review-graph';
import { acgSemanticCompatibility } from '~/schemas/acg-semantic-compatibility';

// WU-1 acceptance: 9 ACG schemas parse a valid example with DITTO-native envelope
// (schema_version + kind + work_item_id/provenance), plus the conditional rules
// (ImpactGraph/ReviewGraph journey nodes, AssuranceSnapshot id uniqueness).

const WI = 'wi_abcd1234';
const AT = '2026-06-03T00:00:00Z';
const changeEnv = (kind: string) => ({
  schema_version: '0.1.0' as const,
  kind,
  work_item_id: WI,
  produced_by: 'agent' as const,
  produced_at: AT,
});

describe('ACG ChangeContract', () => {
  const base = () => ({
    ...changeEnv('acg.change-contract.v1'),
    purpose: '재시도 정책을 지수 백오프로',
    allowed_scope: [{ kind: 'glob' as const, ref: 'src/runtime/**' }],
    forbidden_scope: [{ kind: 'layer' as const, ref: 'kafka-adapter' }],
    acceptance: [{ criterion: '백오프 1s,2s,4s', evidence_kind: 'test' as const }],
  });

  test('valid contract parses (low risk, no decision_ref)', () => {
    expect(acgChangeContract.safeParse(base()).success).toBe(true);
  });

  test('empty forbidden_scope rejected', () => {
    expect(acgChangeContract.safeParse({ ...base(), forbidden_scope: [] }).success).toBe(false);
  });

  test('risk medium without decision_ref rejected (stage-2 gate)', () => {
    expect(acgChangeContract.safeParse({ ...base(), risk_default: 'medium' }).success).toBe(false);
    expect(
      acgChangeContract.safeParse({ ...base(), risk_default: 'medium', decision_ref: 'ADR-7' })
        .success,
    ).toBe(true);
  });
});

describe('ACG ImpactGraph (journey node if/then — OBJ-31)', () => {
  const base = (nodes: unknown[]) => ({
    ...changeEnv('acg.impact-graph.v1'),
    change_target: 'foo()',
    change_type: 'rename' as const,
    affected_nodes: nodes,
  });

  test('non-journey node with path parses; journey node with journey_id parses', () => {
    const ok = base([
      { kind: 'direct_caller', path: 'src/a.ts' },
      { kind: 'user_journey', journey_id: 'jrn-x' },
    ]);
    expect(acgImpactGraph.safeParse(ok).success).toBe(true);
  });

  test('user_journey node WITHOUT path is valid (path not required for journeys)', () => {
    expect(
      acgImpactGraph.safeParse(base([{ kind: 'user_journey', journey_id: 'jrn-x' }])).success,
    ).toBe(true);
  });

  test('user_journey node without journey_id rejected', () => {
    expect(acgImpactGraph.safeParse(base([{ kind: 'user_journey' }])).success).toBe(false);
  });

  test('non-journey node without path rejected', () => {
    expect(acgImpactGraph.safeParse(base([{ kind: 'direct_caller' }])).success).toBe(false);
  });
});

describe('ACG ArchitectureSpec (catalog, no work_item)', () => {
  test('valid spec parses', () => {
    const spec = {
      schema_version: '0.1.0' as const,
      kind: 'acg.architecture-spec.v1' as const,
      produced_by: 'user' as const,
      produced_at: AT,
      layers: { controller: { can_call: ['service'] }, service: { can_call: [] } },
      forbidden_dependencies: [{ from: 'core/**', to: 'cli/**', reason: 'no inward dep' }],
      module_invariants: ['backend SB version single'],
    };
    expect(acgArchitectureSpec.safeParse(spec).success).toBe(true);
  });
});

describe('ACG SemanticCompatibility (split verdict)', () => {
  test('type-safe but semantically unsafe parses', () => {
    const sc = {
      ...changeEnv('acg.semantic-compatibility.v1'),
      changes: [
        {
          before: 'getUser(): User|null',
          after: 'getUser(): User',
          old_meaning: 'null = 미존재',
          compatibility: 'breaking' as const,
          verdict: { type_safe: true, semantic_safe: 'no' as const },
        },
      ],
    };
    expect(acgSemanticCompatibility.safeParse(sc).success).toBe(true);
  });
});

describe('ACG ReviewGraph (acg_review extension, journey role — OBJ-52/53)', () => {
  test('valid: code file with path + journey file with journey_id', () => {
    const rg = {
      kind: 'acg.review-graph.v1' as const,
      files: [
        { path: 'src/a.ts', role: 'service_logic', risk: 'medium', risk_reason: '분기 변경' },
        {
          journey_id: 'jrn-x',
          role: 'user_journey',
          risk: 'high',
          risk_reason: '여정 영향',
          unresolved: true,
        },
      ],
      human_review_set: ['jrn-x'],
    };
    expect(acgReviewGraph.safeParse(rg).success).toBe(true);
  });

  test('user_journey role without journey_id rejected', () => {
    const rg = {
      kind: 'acg.review-graph.v1' as const,
      files: [{ role: 'user_journey', risk: 'high', risk_reason: 'x' }],
    };
    expect(acgReviewGraph.safeParse(rg).success).toBe(false);
  });
});

describe('ACG FitnessFunction', () => {
  const base = () => ({
    schema_version: '0.1.0' as const,
    kind: 'acg.fitness-function.v1' as const,
    produced_by: 'agent' as const,
    produced_at: AT,
    id: 'ff-no-local-jar',
    statement: 'libs/*.jar 금지',
    fitness_kind: 'dependency' as const,
    evaluator: { mode: 'deterministic' as const, spec: "find */libs -name '*.jar' | count == 0" },
    cadence: { per_change: true, periodic: 'on_release' as const },
    on_violation: 'block' as const,
  });

  test('deterministic fitness parses', () => {
    expect(acgFitnessFunction.safeParse(base()).success).toBe(true);
  });

  test('llm_judged without reproducibility rejected', () => {
    const llm = {
      ...base(),
      evaluator: { mode: 'llm_judged' as const, spec: 'judge prompt' },
    };
    expect(acgFitnessFunction.safeParse(llm).success).toBe(false);
  });
});

describe('ACG AssuranceSnapshot (violation_ids uniqueness — OBJ-32)', () => {
  const base = (ids?: string[]) => ({
    schema_version: '0.1.0' as const,
    kind: 'acg.assurance-snapshot.v1' as const,
    produced_by: 'agent' as const,
    produced_at: AT,
    at: AT,
    trigger: 'per_change' as const,
    change_ref: WI,
    results: [
      { function_id: 'ff-x', outcome: 'fail' as const, ...(ids ? { violation_ids: ids } : {}) },
    ],
  });

  test('unique violation_ids parses', () => {
    expect(acgAssuranceSnapshot.safeParse(base(['v1', 'v2'])).success).toBe(true);
  });

  test('duplicate violation_ids rejected (set semantics)', () => {
    expect(acgAssuranceSnapshot.safeParse(base(['v1', 'v1'])).success).toBe(false);
  });
});

describe('ACG JourneySpec (catalog)', () => {
  test('valid journey spec parses', () => {
    const js = {
      schema_version: '0.1.0' as const,
      kind: 'acg.journey-spec.v1' as const,
      produced_by: 'user' as const,
      produced_at: AT,
      id: 'jrn-process-run',
      owner: 'automation-team',
      steps: [{ step_id: 's1', intent: '프로세스 생성' }],
      surfaces: ['/automation/process'],
      evidence_requirement: { kind: 'e2e' as const, must_pass_steps: ['s1'] },
    };
    expect(acgJourneySpec.safeParse(js).success).toBe(true);
  });
});

describe('ACG JourneyRun (binds to e2eJourney)', () => {
  test('valid journey run parses', () => {
    const jr = {
      ...changeEnv('acg.journey-run.v1'),
      journey_id: 'jrn-process-run',
      outcome: 'pass' as const,
      step_results: [{ step_id: 's1', outcome: 'pass' as const }],
    };
    expect(acgJourneyRun.safeParse(jr).success).toBe(true);
  });
});
