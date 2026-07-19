/**
 * v0 구현 계획 적합성(conformance) 테스트 — Milestone 0 (계약·스키마·fixture).
 *
 * 이 파일은 `reports/design/ditto-v0-implementation-plan.md` §2 의 각 build unit
 * **acceptance 조항을 문서에서 직접 인코딩**한 것이다. 기존 테스트를 통과시키는 것이
 * 목적이 아니라, *구현이 계획서대로 되었는지*를 독립적으로 판정한다.
 * 따라서 일부 테스트는 의도적으로 계획서의 요구를 단언하며, 구현이 벗어나면 FAIL 한다
 * (편차는 통과가 아니라 발견의 대상이다). 각 describe 는 plan unit 1:1 매핑.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptanceTestable,
  completionGate,
  convergenceGate,
  deterministicFloor,
  highRiskAssumption,
  interviewReadinessGate,
  safeDefaultable,
} from '~/core/gates';
import * as barrel from '~/schemas';
import { verdict as completionVerdict } from '~/schemas/common';
import { completionContract } from '~/schemas/completion-contract';
import { convergence, honestyKind, ledgerStatus } from '~/schemas/convergence';
import { dialectic, dialecticVerdict, opponentObjection } from '~/schemas/dialectic';
import { handoff } from '~/schemas/handoff';
import { intentContract } from '~/schemas/intent';
import { interviewState } from '~/schemas/interview-state';
import { workItem } from '~/schemas/work-item';
import { exportSchemas, schemaExports } from '../../scripts/export-schemas';

const REPO = join(import.meta.dir, '..', '..');
const SCHEMA_DIR = join(REPO, 'src', 'schemas');
const FIX = join(import.meta.dir, '..', 'fixtures', 'gates');
const readSrc = (name: string): string => readFileSync(join(SCHEMA_DIR, name), 'utf8');
const load = (rel: string): unknown => JSON.parse(readFileSync(join(FIX, rel), 'utf8'));

// 신규 사이드카 7종 (plan §2 M0.2).
const SIDECARS = [
  'intent.ts',
  'question-gate.ts',
  'interview-state.ts',
  'autopilot.ts',
  'dialectic.ts',
  'convergence.ts',
  'handoff.ts',
];

// ─────────────────────────────────────────────────────────────────────────
describe('M0.1 — 기존 스키마 매핑 확정 (재사용·중복 enum 0)', () => {
  // acceptance: "신규 사이드카 스키마가 위 타입만 import해 재사용함을 grep으로 확인.
  //              중복 enum 0건." / "신규 status enum·evidence pointer를 만들지 않는다."
  test('사이드카는 work item status enum 값을 재정의하지 않는다', () => {
    // work item 고유 status 토큰('in_progress'/'abandoned')이 사이드카에 새로 박히면
    // = status enum 중복 정의. 0건이어야 한다.
    for (const file of SIDECARS) {
      const src = readSrc(file);
      expect(src, `${file} redefines work-item status`).not.toContain("'in_progress'");
      expect(src, `${file} redefines work-item status`).not.toContain("'abandoned'");
    }
  });

  test('evidence pointer(evidenceRef)는 common.ts 단일 정의만 존재', () => {
    // evidenceRef.kind 의 리터럴 배열이 사이드카에 다시 나타나면 = evidence pointer 중복 정의.
    const evidenceKindLiteral = "['command', 'file', 'artifact', 'url', 'note']";
    expect(readSrc('common.ts')).toContain(evidenceKindLiteral);
    for (const file of SIDECARS) {
      expect(readSrc(file), `${file} redefines evidenceRef.kind`).not.toContain(
        evidenceKindLiteral,
      );
    }
  });

  test('사이드카는 공유 타입을 common 등에서 import 해 재사용한다', () => {
    // 최소한 schema_version/work_item_id/evidenceRef 같은 공유 타입을 common에서 끌어와야 한다.
    for (const file of SIDECARS) {
      expect(readSrc(file), `${file} must import shared types`).toMatch(/from '\.\/common'/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M0.2 — 신규 사이드카 Zod 스키마 (등록·parse·정합 flag)', () => {
  // acceptance: 7개 신규 스키마가 index.ts barrel 과 export 목록 양쪽에 포함, *.schema.json 생성,
  //             3개 정합 flag 해소.
  const NEW = [
    { exportName: 'intent', barrelConst: 'intentContract' },
    { exportName: 'question-gate', barrelConst: 'questionGate' },
    { exportName: 'interview-state', barrelConst: 'interviewState' },
    { exportName: 'autopilot', barrelConst: 'autopilot' },
    { exportName: 'dialectic', barrelConst: 'dialectic' },
    { exportName: 'convergence', barrelConst: 'convergence' },
    { exportName: 'handoff', barrelConst: 'handoff' },
  ] as const;

  test('7개 신규 스키마가 barrel(index.ts)에 export 됨', () => {
    for (const { barrelConst } of NEW) {
      expect(
        (barrel as Record<string, unknown>)[barrelConst],
        `${barrelConst} missing from barrel`,
      ).toBeDefined();
    }
  });

  test('7개 신규 스키마가 JSON export 레지스트리에 등록됨', () => {
    const names = new Set(schemaExports.map((e) => e.name));
    for (const { exportName } of NEW) {
      expect(names.has(exportName), `${exportName} missing from export registry`).toBe(true);
    }
  });

  test('export 실행 시 7개 *.schema.json 이 실제로 생성된다', async () => {
    const out = await mkdtemp(join(tmpdir(), 'ditto-conf-schemas-'));
    await exportSchemas(out);
    for (const { exportName } of NEW) {
      const path = join(out, `${exportName}.schema.json`);
      expect(await Bun.file(path).exists(), `${exportName}.schema.json not written`).toBe(true);
    }
  });

  test('flag① dialectic Opponent severity 는 별도 major/minor enum이 아니라 common severity 재사용', () => {
    // 계획: critical|major|minor 별도 enum 신설 금지 → common severity(info|low|medium|high|critical) 매핑.
    expect(opponentObjection.shape.severity.safeParse('high').success).toBe(true);
    expect(opponentObjection.shape.severity.safeParse('critical').success).toBe(true);
    expect(opponentObjection.shape.severity.safeParse('major').success).toBe(false);
  });

  test('flag② dialectic Synthesizer verdict 는 completion verdict 와 별개 enum', () => {
    // accept|revise|reject|blocked 신설, completion verdict(pass|partial|fail|unverified)와 교차 거부.
    expect(dialecticVerdict.safeParse('accept').success).toBe(true);
    expect(dialecticVerdict.safeParse('pass').success).toBe(false); // completion verdict 값은 거부
    expect(completionVerdict.safeParse('accept').success).toBe(false); // 역방향도 분리
  });

  test('flag③ convergence kind/status 신규 enum 존재', () => {
    expect(honestyKind.options).toEqual(['finding', 'hypothesis', 'taste']);
    expect(ledgerStatus.options).toEqual(['acted', 'deferred', 'dismissed']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M0.3 — fixture 세트 (valid parse / invalid fail 쌍)', () => {
  // acceptance: 각 스키마별 valid+invalid fixture; valid parse 성공, invalid 실패.
  const CASES: Array<{
    schema: { safeParse: (x: unknown) => { success: boolean } };
    valid: string;
    invalid: string;
  }> = [
    { schema: intentContract, valid: 'intent/observable-ac.json', invalid: 'intent/invalid.json' },
    {
      schema: interviewState,
      valid: 'interview-state/ready.json',
      invalid: 'interview-state/invalid.json',
    },
    {
      schema: completionContract,
      valid: 'completion/pass.json',
      invalid: 'completion/invalid.json',
    },
    {
      schema: convergence,
      valid: 'convergence/converged.json',
      invalid: 'convergence/invalid.json',
    },
    { schema: dialectic, valid: 'dialectic/valid.json', invalid: 'dialectic/invalid.json' },
    { schema: handoff, valid: 'handoff/valid.json', invalid: 'handoff/invalid.json' },
  ];

  for (const { schema, valid, invalid } of CASES) {
    test(`${valid} → parse 성공`, () => {
      expect(schema.safeParse(load(valid)).success).toBe(true);
    });
    test(`${invalid} → parse 실패`, () => {
      expect(schema.safeParse(load(invalid)).success).toBe(false);
    });
  }

  test('work item ↔ completion AC 불일치 3종 fixture(누락·잉여·중복) 존재', () => {
    // plan §2 M0.3 (c'): completionGate 가 FAIL 낼 cross-check fixture 가 갖춰져 있어야 한다.
    expect(workItem.safeParse(load('completion-crosscheck/workitem.json')).success).toBe(true);
    for (const f of [
      'completion-match',
      'completion-missing',
      'completion-extra',
      'completion-duplicate',
    ]) {
      expect(completionContract.safeParse(load(`completion-crosscheck/${f}.json`)).success).toBe(
        true,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('M0.4 — 결정론 게이트 + fixture 판정 (verifier가 판정)', () => {
  // acceptance: M0.3 fixture 에 게이트 적용 → 기대 판정과 일치. LLM 호출 없음(D5: 결정론 1차).

  test('completionGate: AC 집합 일치 → PASS, 누락/잉여/중복 → FAIL', () => {
    const item = workItem.parse(load('completion-crosscheck/workitem.json'));
    const match = completionContract.parse(load('completion-crosscheck/completion-match.json'));
    const missing = completionContract.parse(load('completion-crosscheck/completion-missing.json'));
    const extra = completionContract.parse(load('completion-crosscheck/completion-extra.json'));
    const dup = completionContract.parse(load('completion-crosscheck/completion-duplicate.json'));

    expect(completionGate(item, match).pass).toBe(true);
    expect(completionGate(item, missing).pass).toBe(false);
    expect(completionGate(item, missing).reasons.join(' ')).toMatch(/missing/);
    expect(completionGate(item, extra).pass).toBe(false);
    expect(completionGate(item, extra).reasons.join(' ')).toMatch(/extra/);
    // 중복은 Set 비교로는 못 잡으므로 count 검사 요구 (plan §2 M0.4 주의).
    expect(completionGate(item, dup).pass).toBe(false);
    expect(completionGate(item, dup).reasons.join(' ')).toMatch(/duplicate/);
  });

  // Liveness fix (wi_260719agy): treadmill.json is cap_reached/ledger_only — a valid
  // budget-exhausted terminal closure, NOT a re-forced round. deriveClosureMode maps it
  // to a ledger_only floor, so convergenceGate PASSES it (mirrors tests/core/gates.test.ts).
  // early-converge.json is exit.reason=converged and correctly still FAILS the consistency
  // check; the cap_reached carve-out does not touch it.
  test('convergenceGate: converged → PASS, treadmill (cap_reached/ledger_only) → PASS, early-converge → FAIL', () => {
    expect(convergenceGate(convergence.parse(load('convergence/converged.json'))).pass).toBe(true);
    expect(convergenceGate(convergence.parse(load('convergence/treadmill.json'))).pass).toBe(true);
    expect(convergenceGate(convergence.parse(load('convergence/early-converge.json'))).pass).toBe(
      false,
    );
  });

  test('acceptanceTestable: vague AC → FAIL, observable AC → PASS', () => {
    const vague = intentContract.parse(load('intent/vague-ac.json'));
    for (const ac of vague.acceptance_criteria) {
      expect(acceptanceTestable({ statement: ac.statement }).pass, ac.statement).toBe(false);
    }
    const observable = intentContract.parse(load('intent/observable-ac.json'));
    for (const ac of observable.acceptance_criteria) {
      expect(acceptanceTestable({ statement: ac.statement }).pass, ac.statement).toBe(true);
    }
  });

  test('interviewReadinessGate: ready → PASS, blocked(critical 미해결) → FAIL', () => {
    expect(
      interviewReadinessGate(interviewState.parse(load('interview-state/ready.json'))).pass,
    ).toBe(true);
    expect(
      interviewReadinessGate(interviewState.parse(load('interview-state/blocked.json'))).pass,
    ).toBe(false);
  });

  test('deterministicFloor: 가중합 + [0,1] clamp', () => {
    expect(
      deterministicFloor({ open_required_sections: 0, conflicting: 0, assumption_ratio: 0 }),
    ).toBe(0);
    expect(
      deterministicFloor({ open_required_sections: 2, conflicting: 1, assumption_ratio: 1 }),
    ).toBeCloseTo(0.05 * 2 + 0.1 + 0.05, 5);
    expect(
      deterministicFloor({ open_required_sections: 100, conflicting: 100, assumption_ratio: 1 }),
    ).toBe(1);
  });

  test('highRiskAssumption(3축 OR) / safeDefaultable = ¬highRisk (§8-4 한 술어 양면)', () => {
    expect(highRiskAssumption({ non_local: true, irreversible: false, unaudited: false })).toBe(
      true,
    );
    expect(highRiskAssumption({ non_local: false, irreversible: true, unaudited: false })).toBe(
      true,
    );
    expect(highRiskAssumption({ non_local: false, irreversible: false, unaudited: true })).toBe(
      true,
    );
    expect(highRiskAssumption({ non_local: false, irreversible: false, unaudited: false })).toBe(
      false,
    );
    for (const axes of [
      { non_local: true, irreversible: false, unaudited: false },
      { non_local: false, irreversible: false, unaudited: false },
    ]) {
      expect(safeDefaultable(axes)).toBe(!highRiskAssumption(axes));
    }
  });
});
