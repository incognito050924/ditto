# Plan — wi_v04verifier_body_and_declared_by (wi_260531vdw)

## 배경

설계서 line 700은 완료 판정의 주체를 "판정 주체(verifier)"로 규정한다. 그러나 코드에는 두 갈래의 silent divergence가 있다:

1. **`agents/verifier.md`** 본문이 skeleton 상태다 — line 19: `> v0 skeleton: role/permission boundary only. Content logic is filled in a later milestone.` 역할/권한 경계만 있고 실제 검증 절차가 비어 있다.
2. **`CompletionContract.declared_by`** 가 자유 문자열(`z.string().min(1)`)이고, `work-item-handoff.ts:114`가 거기에 `item.owner_profile`(실행 프로파일, 예 `workspace-write`)을 박는다. 모든 fixture(8건)·닫힌 work item artifact가 `declared_by: "workspace-write"`다. 즉 "누가 이 완료를 선언했는가"(역할)와 "어떤 권한 프로파일로 실행됐는가"가 한 필드에 뭉개져 있다.

본 work item은 이 둘을 닫는다. 핵심은 **판정 주체를 역할 enum으로 명시**해, implementer가 자기 작업을 `verifier`라 사칭하거나 실행 프로파일 문자열을 declarer로 박는 것을 schema 단에서 막는 것이다.

조사로 확인한 사실(fresh):
- `declared_by`를 **읽어서 권한을 결정하는 소비처는 없다**. `completion-store.ts:20`의 input 타입(string)뿐. → enum 좁히기는 permission 로직에 영향 없는 저위험 변경.
- `completion-store.test.ts`·`m3.conformance.test.ts`는 이미 `declaredBy: 'verifier'`를 쓴다 — 마이그레이션 무관하게 통과.

## 새 용어 도입 (사용자가 처음 보는 것)

| 이름 | 1줄 정의 |
|---|---|
| `declarerRole` (= 완료 주장을 만든 agent 역할) | `CompletionContract.declared_by`에 들어갈 값의 enum. 실행 프로파일 `profileName`과 **다른 개념** — "누가 판정했나"이지 "어떤 권한으로 돌았나"가 아니다. |

## AC (work-item.json과 동일, 요약)

- **AC-1** `declarerRole` enum 신규 (`common.ts`). `['main','planner','implementer','verifier','reviewer','researcher','synthesizer']`.
- **AC-2** `CompletionContract.declared_by` → `declarerRole`. `completion-store` input 타입도 좁힘.
- **AC-3** `work-item-handoff.ts:114` `owner_profile` 박는 path 제거 → `'main'`. `ditto work handoff --declared-by` 옵션(default `main`).
- **AC-4** 모든 completion fixture/artifact 의미 단위 마이그레이션 (`workspace-write` → `main`|`verifier`).
- **AC-5** `agents/verifier.md` 본문 채움 (검증 절차 + verdict 박는 절차 + `declared_by='verifier'` 규칙).
- **AC-6** 회귀(bun test 전체 + lint) + M3 conformance 신규 단언(verifier-as-declarer CONFORMS, impersonation reject) + matrix/plan §M3 갱신.

## [DECIDED] (메모리 project_v04_runtime_wiring에서 가져온 결정 — 그대로 적용)

- `declarerRole` 값 = `'main' | 'planner' | 'implementer' | 'verifier' | 'reviewer' | 'researcher' | 'synthesizer'`. `synthesizer`는 ③(dialectic) 호환 위해 미리 포함.
- fixture 마이그레이션 대상값: handoff CLI 생성물 → `main`, verifier가 실제 declarer인 fixture → `verifier`. 의미 단위 분리.
- `.ditto/work-items/*/completion.json`(닫힌 work item)도 `main`으로 마이그레이션 — enum 좁힌 뒤 invalid가 되는 landmine 제거. (단 `dod.md`의 부정 예제 `"declared_by":"x"`는 illustrative라 유지.)

## 변경 대상

| 파일 | 변경 | AC | 유형 |
|---|---|---|---|
| `src/schemas/common.ts` | `declarerRole` enum export 추가 | AC-1 | 구조적 |
| `src/schemas/completion-contract.ts` | `declared_by: declarerRole` | AC-2 | 동작적 |
| `src/core/completion-store.ts` | `declaredBy` input 타입 `DeclarerRole` | AC-2 | 동작적 |
| `src/core/work-item-handoff.ts` | `declared_by: 'main'` (옵션 전달) | AC-3 | 동작적 |
| `src/cli/commands/work.ts` | handoff `--declared-by` 옵션(default main) | AC-3 | 동작적 |
| `tests/fixtures/gates/**`, `tests/schemas/fixture-validation.test.ts`, `tests/hooks/stop.test.ts`, `tests/fixtures/scenarios/**`, `tests/conformance/m1`, `.ditto/work-items/*/completion.json` | `workspace-write` → `main`\|`verifier` | AC-4 | 마이그레이션 |
| `agents/verifier.md` | skeleton 제거 + 본문 | AC-5 | 동작적 |
| `tests/conformance/m3.conformance.test.ts` | verifier-as-declarer + impersonation reject 단언 | AC-6 | 동작적/검증 |
| `reports/design/ditto-v0-conformance-matrix.md`, `reports/design/ditto-v0-implementation-plan.md` | M3 § 갱신 | AC-6 | 검증 전용 |

## Tidy First 분리 (예상 commits)

구조적 먼저:
1. `refactor(M3): add declarerRole enum to common schema (구조적)` — 신규 export만, 미사용.

동작적:
2. `feat(M3): completion declared_by uses declarerRole + migrate handoff path & fixtures (동작적)` — AC-2/3/4 (schema 좁히기 + handoff path + CLI 옵션 + 전 fixture/artifact 마이그레이션을 한 묶음으로 — 테스트 green 유지 위해 분리 불가).
3. `feat(M3): verifier.md body — per-criterion verification procedure (동작적)` — AC-5.
4. `feat(M3): conformance — verifier-as-declarer CONFORMS + impersonation reject (동작적)` — AC-6 단언.
5. `docs(v0): conformance matrix + plan §M3 reflect wi_v04verifier_body_and_declared_by (검증 전용)` — AC-6 문서.
6. `docs(ditto): close wi_v04verifier_body_and_declared_by — AC-1..AC-6 pass`.

## 검증

```
bun test
bun test tests/schemas
bun test tests/conformance/m3.conformance.test.ts
bun test tests/core/work-item-handoff.test.ts tests/cli
bun run lint
```

## 위험 / 되돌리기

- enum 좁히기는 `declared_by`를 읽어 권한 결정하는 소비처가 없어 저위험. 되돌리려면 `declarerRole`을 `z.string().min(1)`로 복귀 + fixture 역마이그레이션 — 단일 schema 줄 + sed.
- `.ditto` artifact 마이그레이션은 역사적 기록 변경 — 그러나 전부 handoff CLI(`main`) 출처가 명확하고, enum landmine 제거가 목적. 부정 예제(dod.md)는 보존.

## 범위 밖

- `agents/reviewer.md` 본문 (별도 milestone).
- DialecticDeliberationContract runtime / dialectic-synthesizer 본문 (③ wi_v04dialectic_runtime).
- `owner_profile` 자체의 의미 변경 — 실행 프로파일로 그대로 둔다. 이번엔 `declared_by`만 분리.
