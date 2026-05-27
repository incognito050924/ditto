---
title: "DITTO Convergence Contract (상세 설계)"
kind: design-detail
last_updated: 2026-05-26 KST
status: draft
parent: reports/design/ditto-claude-code-harness-design.md
owns: "§6.9 Convergence Contract의 'how' (admissibility 게이트 메커니즘 · ratchet · decision ledger · 정직 라벨 · convergence.json 스키마)"
inputs:
  - reports/design/ditto-claude-code-harness-design.md  # §0 제1원칙, §3.3 권위, §6.8 Completion(쌍대), §6.9 Convergence(what), §11 원칙 10, §12 Milestone 3
  - reports/design/contracts/autopilot-contract.md  # §4.3 노드 retry/fix 정련 루프가 ConvergenceGate에 묶임
  - reports/harnesses/ouroboros.md                      # 주 참조 — deterministic_floor · backend∧ledger 쌍대 게이트 · cap≠converged · closure 분기 (기준 커밋 d47b1431)
  - reports/harnesses/hannes.md                          # Convergence는 HANNES 선행구현이 없는 유일한 신규 계약(count 기반 escalation만 존재)
  - src/schemas/common.ts, src/schemas/completion-contract.ts  # 재사용 스키마 (authoritative)
---

# DITTO Convergence Contract (상세 설계)

> **이 문서의 위치.** 이것은 메인 설계문서(`ditto-claude-code-harness-design.md`)의 §6.9를 대체하지 않고 **확장**한다. 메인은 "무엇(what)" — 두 게이트 교집합으로서의 수렴 정의, admissibility·ratchet·정직 라벨의 *원칙* — 만 두고 "어떻게(how)"는 열어둔다. 이 문서가 그 how — admissibility 게이트의 판정 메커니즘, ratchet(최선본 보존·decision ledger)의 구조, 정직 라벨의 스키마화, `convergence.json` 사이드카 — 를 소유한다. per-contract 상세 문서의 **네 번째 사례**다(앞선 사례: [`deep-interview-contract.md`](deep-interview-contract.md), [`autopilot-contract.md`](autopilot-contract.md), [`dialectic-deliberation-contract.md`](dialectic-deliberation-contract.md)).

## 0. 권위 규칙 (메인 ↔ 상세 ↔ 스키마)

| 층위 | 소유 대상 | 충돌 시 |
|---|---|---|
| 실제 스키마 (`src/schemas/*.ts`, `schemas/*.json`) | 필드명, enum, validation | **최우선.** 본 문서 예시 JSON과 다르면 스키마가 이긴다. |
| 메인 설계문서 §6.9 | "what" — 수렴 정의, admissibility·ratchet·정직 라벨의 원칙, cap≠converged | "what"이 충돌하면 메인이 이긴다. 본 문서는 메인과 모순되면 안 된다. |
| 본 상세문서 | "how" — admissibility 판정 절차, ratchet 구조, 정직 라벨 스키마, `convergence.json` | "how"의 단일 출처. 메인은 여기로 링크만 한다. |

규칙: 본 문서의 예시 스키마는 **구현 전 반드시** 기존 Zod/JSON 스키마와 맞춘다. `convergence.json`은 additive 사이드카이며 `completion.json`(§6.8, `src/schemas/completion-contract.ts`)을 **대체하지 않는다**(메인 §6.9 저장 위치). 수렴의 verdict·work item status는 본 문서가 정하지 않는다 — CompletionContract(§6.8)가 정하고, 본 문서는 그 입력(정련 종료 여부)만 지배한다.

## 1. 목적과 경계

### 1.1 한 문장 정의

Convergence는 **반복 정련(review→edit, verify→fix, dialectic 라운드)이 treadmill(같은 지점 진동·점진적 품질 저하)에도, 조기 수렴(명백한 이슈 무시·no-op 답변·정해진 횟수만 돌고 종료)에도 빠지지 않게, 정련 루프의 *계속/멈춤*을 admissibility·ratchet으로 지배하는 계약**이다.

핵심 명제(메인 §0 제1원칙의 직접 파생): **행동의 바와 드러내기의 바가 다르다.** 드러내기(surface)는 낮은 바 — 취향·가설·sub-threshold 우려도 숨기지 않고 원장에 기록한다. 행동(edit·continue·done 선언)은 높은 바 — 증거와 acceptance criterion에 연결된 것만 통과한다. Convergence는 이 두 바의 *간격*을 정련 루프 위에서 집행하는 메커니즘이다. 그래서 수렴은 게이트 하나로 정의할 수 없다 — **방향이 반대인 두 게이트가 동시에 만족되는 교집합**이 고정점이다(메인 §6.9).

### 1.2 인접 계약과의 경계 (쌍대 관계 명시)

| 계약 | 다루는 것 | Convergence와의 차이 (쌍대성) |
|---|---|---|
| **§6.8 Completion** | `final_verdict` 판정, AC별 증거 충족, work item status 결정 | **본 계약의 쌍대(dual).** Completion=`CompletionGate`(조기 멈춤·거짓 done 차단, *적극* 충족 시 STOP 가능). Convergence=`ConvergenceGate`(treadmill·트집 무한루프 차단, admissible 반론 있어야 CONTINUE 가능). **`done`은 두 게이트 동시 만족으로만 정의.** verdict·status는 §6.8이 결정, 정련 *지속*은 본 계약이 결정. `convergence.json`은 `completion.json`을 대체하지 않는 additive 쌍대 사이드카(§0). |
| §6.5 Autopilot | 그래프 진행, 노드별 retry/switch 결정 | autopilot은 *그래프 진행*, Convergence는 *한 지점의 정련*. 노드의 retry/fix 정련 루프 *내부* 종료를 본 계약이 admissibility·ratchet으로 지배하고, autopilot은 그 결과(passed/failed)만 받는다([`autopilot-contract.md`](autopilot-contract.md) §4.3). `cap-reached ≠ converged`를 공유. |
| §6.6 DialecticDeliberation | Producer/Opponent/Synthesizer 적대 라운드 | Dialectic은 반론을 *생성*, Convergence는 그 반론이 *행동할 자격*(admissibility)이 있는지와 라운드를 *언제 멈출지*를 판정. 둘은 같은 정련 루프의 생성기↔게이트. |
| §6.3 Deep Interview | intent 층위 readiness 게이트 | intent의 readiness 쌍대 게이트(critical-resolved ∧ score)와 *동형*이지만 층위가 다르다. Deep Interview는 intent 모호성, Convergence는 산출물 정련. `cap_reached ≠ ready`(deep-interview §4.3)와 `cap-reached ≠ converged`는 같은 원칙의 두 적용. |

## 2. 수렴 정의 (두 게이트의 교집합)

수렴은 카운트나 "더 할 말 없는 느낌"이 아니다(메인 §6.9). 두 게이트가 같은 라운드에 동시에 만족될 때만 `done`이다.

| 게이트 | 막는 고장 | 통과 조건 |
|---|---|---|
| `CompletionGate` (§6.8) | 조기 멈춤, no-op, 거짓 "done" | 모든 acceptance criterion이 증거로 *적극* 충족(`completion.json` superRefine: `final_verdict=pass ⇒ 모든 AC pass ∧ in-scope unverified 0`) |
| `ConvergenceGate` (본 절) | treadmill, 트집 무한 루프, 품질 저하 | grounded·novel·admissible 반론이 **0개**일 때만 CONTINUE 불요 → STOP 가능 |

- `done` ⟺ **모든 AC가 증거로 닫힘**(CompletionGate) AND **admissible한 열린 반론 0개**(ConvergenceGate).
- **라운드 1에 이게 참이면 라운드 1에 멈춘다.** "최소 N라운드"는 없다. 명백한 done을 정해진 횟수만큼 돌게 하는 것이 곧 조기 수렴의 거울상(공회전)이다.
- 라운드 N에도 거짓이면 끝난 게 아니다 — non-pass로 닫고, 최종 verdict(`partial|fail|unverified`)와 work item status는 CompletionContract(§6.8)가 결정한다(§5 cap-reached).

> **ouroboros 레퍼런스 구현.** "두 게이트 동시 만족 = done"은 이미 코드로 존재한다. ouroboros 인터뷰는 **backend(semantic ambiguity 모델)가 `seed_ready`이고 *동시에* 드라이버측 ledger(structural 완전성)가 `is_seed_ready()`일 때만** 닫힌다(`auto/interview_driver.py:204-227`, [`ouroboros.md`](../../harnesses/ouroboros.md) §2). 어느 한쪽만 done이면 종료하지 않고 다음 답변으로 재구성한다 — **일방적 종료를 절대 받지 않는다.** DITTO의 CompletionGate ∧ ConvergenceGate가 이 `backend_done AND ledger_done`과 정확히 동형이다([`deep-interview-contract.md`](deep-interview-contract.md) §9와 정합).

## 3. Admissibility Gate (반론이 *행동*을 트리거할 자격)

ConvergenceGate의 핵심은 "이 반론이 또 한 라운드의 edit을 정당화하는가"를 판정하는 admissibility 게이트다. 자격 없는 반론은 트집(treadmill 연료)이고, 자격 있는 반론을 묵살하면 조기 수렴이다.

### 3.1 admissible 3조건 (AND)

반론은 아래 셋을 **모두** 만족할 때만 admissible하다(메인 §6.9).

| 조건 | id | 판정 | 위반 시 |
|---|---|---|---|
| (a) **oracle** | criterion-linked | 구체적 반례를 인스턴스화하거나, 위반하는 acceptance criterion에 매핑된다(`criterion_id`). | criterion에 못 묶이면 행동(edit) 트리거 못 함 → §4 정직 라벨로 *드러내되* `dismissed` 처리(취향·criterion-less). |
| (b) **memory** | novel | decision ledger(§4)에 같은 지점이 없던 신규다. | 이미 기각된 지점을 새 근거 없이 재제기 → **자동 각하**(§4.2, A→B→A 진동 차단). |
| (c) **severity** | critical\|major | `severity ∈ {critical, major}`(스키마는 `common.ts`의 5단계 중 `critical|high` 매핑, §6.2). | minor/info는 드러내되 행동 트리거 안 함 → `deferred`. |

세 조건은 **드러내기**를 막지 않는다 — inadmissible 반론도 ledger에 전부 기록된다(낮은 바). 막는 것은 **행동**(또 한 라운드)이다(높은 바). 이것이 메인 §0의 "백킹 없는 생성을 행동으로 전환되기 전에 무력하게"의 정련 루프 구현이다.

### 3.2 대칭 원칙 (기각도 raise만큼 든다)

- 반론을 *기각*하는 데도 raise만큼의 이유+근거가 든다(메인 §6.9). **무료 묵살 금지.**
- 즉, ledger 엔트리는 `raised`든 `dismissed`든 동일하게 `reason`(왜 채택/기각)과 `evidence_refs`(근거)를 요구한다(§4.1 스키마). "근거 없이 dismiss"는 schema validation 실패로 만든다.
- 효과: 기각이 비대칭적으로 싸지 않으므로, 게이트가 admissible 반론을 슬쩍 묵살해 조기 수렴하는 경로가 막힌다.

### 3.3 묵살 불가 원칙 (criteria가 바닥)

- **acceptance criterion에 매핑되는 반론은 절대 inadmissible로 선언할 수 없다**(메인 §6.9). criteria가 바닥이다.
- 게이트는 **취향(taste)·criterion 없는 반론만** 거른다. criterion-linked 반론을 `dismissed`로 닫으려면 그 criterion 자체가 충족됐다는 증거(oracle 충족)를 제시해야 하지, 게이트 권한으로 묵살할 수 없다.
- 스키마 강제: `정체(kind)=taste`인 항목만 `criterion_id` 없이 `dismissed` 가능. `kind=finding`이면서 `criterion_id`가 있으면 `dismissed` 사유로 "inadmissible 선언"을 쓸 수 없게 한다(§4.1 refine 후보).

> **ouroboros 레퍼런스.** ouroboros는 admissibility를 source×status 타입으로 구현한다 — INFERENCE/ASSUMPTION은 `assumption_only_sections`로 분리하고, 동일 키 충돌은 merge를 발명하지 않고 `CONFLICTING`으로 남겨 드라이버가 *차단*한다(`auto/ledger.py:11-103`, [`ouroboros.md`](../../harnesses/ouroboros.md) §3). evidence-backed vs assumption-only 분리가 곧 본 계약의 finding vs hypothesis다(§4).

## 4. Ratchet (품질 단조 비퇴행)

ratchet은 정련이 *나아지기만* 하고 퇴행하지 않게 만드는 두 메커니즘이다 — 최선본 보존과 decision ledger.

### 4.1 최선본 보존 (degradation을 정의상 불가능하게)

- **모든 버전을 불변 기준으로 점수 매긴다.** 점수 기준은 라운드마다 바뀌지 않는다(불변 기준이라야 비교가 의미 있다).
- **산출물은 "마지막 버전"이 아니라 "최고 점수 버전"이다.** 마지막 라운드가 더 나빠졌더라도 산출은 최고점 버전으로 한다 → degradation이 정의상 불가능해진다(메인 §6.9).
- `convergence.json.versions[]`에 버전별 점수를 남기고, `selected_version`은 항상 `argmax(score)`다(§6 스키마).

### 4.2 decision ledger (재제기 자동 각하)

- 채택(`raised`)/기각(`dismissed`)한 모든 반론을 **이유+근거와 함께 기록**하고 다음 라운드에 구속력을 준다(메인 §6.9).
- 이미 기각된 지점을 **새 근거 없이 재제기하면 자동 각하**한다 → A→B→A 진동이 불가능해진다. "새 근거"는 새 `evidence_refs` 또는 새 `criterion_id`로 정의한다(둘 다 없으면 novel=false, §3.1(b)).
- ledger는 append-only다. 한 번 쓴 결정 엔트리는 수정하지 않고, 번복은 새 엔트리(`supersedes` 포인터)로 남긴다 — 회고·감사 가능성 보존.

> **ouroboros 레퍼런스 — safe-default 롤백 invariant.** ratchet의 "퇴행 불가"는 ouroboros의 종료 시 롤백 invariant와 동형이다. ouroboros는 `max_rounds` 후 안전 기본값으로 닫을 수 있는 gap만 닫고, synthesis가 transcript와 비동기화되면 **롤백**한다(`auto/interview_driver.py:339-555`, `:805-833`, [`ouroboros.md`](../../harnesses/ouroboros.md) §2·근거목록). SSOT(여기선 최고점 버전)를 손상시키는 정련은 받지 않는다.

### 4.3 모델 자기보고를 코드 바닥으로 누르기 (선택적 강화)

메인 §0 제1원칙의 구현으로, 점수 산정 시 LLM 자기평가를 그대로 신뢰하지 않고 **결정론적 바닥과 `max()`로 결합**할 수 있다. ouroboros의 `deterministic_floor(ledger)`(`auto/grading.py:401-425`)는 `0.05·열린 필수 섹션 + 0.10·활성 CONFLICTING 엔트리 + 0.05·assumption_only 비율`로 모호성 바닥을 계산하고, 파이프라인은 `max(llm_reported_score, deterministic_floor)`를 채택한다(`auto/pipeline.py:642-651`, [`ouroboros.md`](../../harnesses/ouroboros.md) §1). DITTO Convergence에 적용 시: admissible 반론 개수는 LLM이 "0개"라 보고해도, criterion-linked 미충족이 구조적으로 측정되면 코드가 그 바닥을 강제한다(LLM이 admissible 반론을 0으로 과소보고 못 함). 임계·공식은 configurable(메인 §16), 본 문서는 구조만 박는다.

## 5. cap-reached ≠ converged (캡은 안전정지지 성공 아님)

- 라운드 캡(`round_cap`)은 **안전 정지**이지 성공 조건이 아니다(메인 §6.9). 캡 도달이 "충분히 정련했다"가 아니다.
- 캡에서 두 게이트(완료↔수렴)를 만족 못 했으면 그건 `done`이 아니라 **non-pass**다 — 그 정련 지점(노드)을 닫고, 전체 verdict는 CompletionContract가 `partial|fail|unverified`로 결정(`completion-contract.ts`의 `final_verdict`), `next_handoff_path` 요구(같은 스키마 refine: non-pass ⇒ handoff 필수) + handoff한다(§6.8, §6.10).
- 이는 [`autopilot-contract.md`](autopilot-contract.md) §4.3과 정합 — 노드별 `caps.fix_per_node`/`switch_per_node` 도달 시 노드를 `failed`로 닫고 verdict를 §6.8에 위임하는 것과 동일 규칙. deep-interview §4.3의 `cap_reached ≠ ready`와도 동형.

> **ouroboros 레퍼런스 — closure 분기.** `cap-reached ≠ converged`는 ouroboros의 `max_rounds` 후 분기가 그대로다(`auto/interview_driver.py:339-555`, `state.py:378-379`, [`ouroboros.md`](../../harnesses/ouroboros.md) §2): backend∧ledger 동의 → `mutual_agreement`; ledger만 done → `ledger_only`(advisory); 안전 기본값만 남음 → `safe_default`(실패 시 롤백); 안전하지 않은 gap → **blocked**. 캡 도달 자체가 성공 라벨이 아니라 closure mode로 정직하게 기록된다.

## 6. 정직 라벨 + convergence.json 스키마

### 6.1 정직 라벨 (제1원칙 투명성의 스키마화)

모든 산출물/반론 항목에 세 라벨을 붙인다(메인 §6.9). 라벨은 메인 §0의 "행동의 바 ≠ 드러내기의 바"를 항목 단위로 집행한다.

| 라벨 | 값 | 의미 / 규칙 |
|---|---|---|
| **정체** (`kind`) | `finding` \| `hypothesis` \| `taste` | 무엇인가. **백킹(근거·oracle) 없는 주장은 `finding`이 아니라 `hypothesis`** — 행동하지 않는다(메인 §6.9). `taste`는 criterion 없는 선호. |
| **확신** (`confidence`) | `high` \| `medium` \| `low` + `backed_by` | 근거/oracle 출처. 백킹 없으면 `low` 명시 강제(스키마 refine: `kind=finding ⇒ backed_by 비어있지 않음`). |
| **상태** (`status`) | `acted` \| `deferred` \| `dismissed` + `reason` | 무엇을 했나. `dismissed`/`deferred`는 `reason` 필수(§3.2 대칭 원칙). |

**계층적 투명성**(메인 §6.9): 숨기는 것은 없되 actionable(=admissible, `status=acted` 후보)을 전면에 두고, 나머지(`deferred`/`dismissed`/`hypothesis`/`taste`)는 접거나 on-demand로 둔다. "모든 이슈를 같은 볼륨으로 쏟기"는 정직이 아니라 노이즈 복원이다. ledger에는 전부 남되 렌더링이 계층적이다.

### 6.2 `convergence.json` (예시 — 구현 전 Zod/JSON 스키마와 정합)

재사용(`src/schemas/common.ts`, 본 문서 직접 확인): `schema_version`(`z.literal('0.1.0')`), `work_item_id`(`/^wi_[a-z0-9]{8,}$/`), `evidenceRef`(`kind: command|file|artifact|url|note` + `summary|sha256|lines`)를 그대로 쓴다. `severity`(`info|low|medium|high|critical`)와 `verdict`(`pass|partial|fail|unverified`)도 `common.ts`를 재사용한다. admissibility의 `critical|major`는 `severity`의 `critical|high`로 매핑한다(새 enum 신설 금지). 새 enum(`kind`, `status`)만 신설한다.

```json
{
  "schema_version": "0.1.0",
  "work_item_id": "wi_example1234",
  "target_ref": "N3 | rv_example1234 | AC-set",
  "round_cap": 3,
  "rounds_run": 2,
  "versions": [
    { "version": 1, "score": 0.71, "evidence_refs": [] },
    { "version": 2, "score": 0.88, "evidence_refs": [] }
  ],
  "selected_version": 2,
  "decision_ledger": [
    {
      "id": "OBJ-1",
      "round": 1,
      "objection": "AC-2 경계값(빈 입력)에서 반례 발생",
      "kind": "finding",
      "criterion_id": "AC-2",
      "severity": "high",
      "admissible": true,
      "status": "acted",
      "confidence": "high",
      "backed_by": [{ "kind": "command", "command": "npm test -- empty-input", "summary": "1 failed" }],
      "reason": "criterion-linked·novel·major → admissible, 다음 라운드 edit 트리거",
      "supersedes": null
    },
    {
      "id": "OBJ-2",
      "round": 2,
      "objection": "변수명이 더 우아할 수 있음",
      "kind": "taste",
      "criterion_id": null,
      "severity": "low",
      "admissible": false,
      "status": "dismissed",
      "confidence": "low",
      "backed_by": [],
      "reason": "criterion 없음(taste). 드러내되 행동 트리거 안 함(§3.1a, §3.3)",
      "supersedes": null
    }
  ],
  "open_admissible_count": 0,
  "gate": {
    "completion_gate": "pass",
    "convergence_gate": "no_open_admissible",
    "converged": true
  },
  "exit": {
    "reason": "converged|cap_reached|blocked",
    "verdict_delegated_to_completion": true,
    "next_handoff_path": null
  }
}
```

규칙(스키마 정합·구현 전 확정):
- `decision_ledger`는 append-only. 번복은 새 엔트리 + `supersedes` 포인터로만(§4.2).
- `selected_version == argmax(versions[].score)` 불변(§4.1). 마지막 버전이 아니다.
- `gate.converged = (completion_gate=='pass') && (open_admissible_count==0)` — 두 게이트 교집합(§2).
- `exit.reason='cap_reached'`이고 `converged=false`면 `verdict_delegated_to_completion=true` + `next_handoff_path` 요구(§5).
- `kind=finding ⇒ backed_by` 비어있지 않음, `status∈{dismissed,deferred} ⇒ reason` 필수(§3.2, §6.1).

## 7. 불변 규칙 요약 (체크리스트)

- [ ] `done`은 두 게이트(CompletionGate ∧ ConvergenceGate) 동시 만족으로만 정의된다. 카운트·느낌 금지.
- [ ] 라운드 1에 두 게이트가 참이면 라운드 1에 멈춘다. "최소 N라운드" 없음.
- [ ] 반론은 oracle(criterion-linked) ∧ memory(novel) ∧ severity(critical|major) 셋 다일 때만 admissible(행동 트리거).
- [ ] inadmissible 반론도 ledger에 *드러낸다*(낮은 바). 막는 건 행동이지 드러내기가 아니다.
- [ ] 기각도 raise만큼 이유+근거가 든다. 근거 없는 dismiss는 schema 위반(대칭 원칙).
- [ ] criterion-linked 반론은 inadmissible로 선언 불가. 게이트는 taste·criterion-less만 거른다(묵살 불가).
- [ ] 산출물은 최고 점수 버전(`argmax`)이지 마지막 버전이 아니다. degradation 정의상 불가.
- [ ] 이미 기각된 지점을 새 근거 없이 재제기하면 자동 각하(A→B→A 진동 차단).
- [ ] `cap-reached ≠ converged`. 캡에서 미수렴이면 non-pass로 닫고 verdict는 §6.8, + handoff.
- [ ] 정체=`hypothesis`(백킹 없음)는 행동하지 않는다. `finding`은 `backed_by` 필수.
- [ ] 투명성은 계층적 — 전부 ledger에, actionable만 전면, 나머지 접음/on-demand.
- [ ] verdict·work item status는 본 계약이 정하지 않는다 — §6.8 CompletionContract가 결정.

## 8. 참조 하네스 매핑 (무엇을 어디서 차용했는가)

| 차용 요소 | 출처 | 본 설계 반영 |
|---|---|---|
| 두 게이트 동시 만족 = done (backend ∧ ledger) | ouroboros 이중 합의 종료 (`auto/interview_driver.py:204-227`, [`ouroboros.md`](../../harnesses/ouroboros.md) §2) | §2 수렴 정의 |
| `cap-reached ≠ converged` + closure mode 분기 | ouroboros `mutual_agreement/ledger_only/safe_default/blocked` (`auto/interview_driver.py:339-555`, `state.py:378-379`) | §5 |
| 최선본 보존·롤백 invariant (SSOT 비손상) | ouroboros safe-default 롤백 (`auto/interview_driver.py:805-833`) | §4.1, §4.2 |
| source×status provenance = finding vs hypothesis | ouroboros Seed Ledger (`auto/ledger.py:11-103`) | §3.3, §6.1 정직 라벨 |
| 모델 자기보고를 코드 바닥으로 누름 | ouroboros `deterministic_floor` + `max(llm, floor)` (`auto/grading.py:401-425`, `auto/pipeline.py:642-651`) | §4.3 |
| 노드 retry/fix 정련 루프가 ConvergenceGate에 묶임 | DITTO [`autopilot-contract.md`](autopilot-contract.md) §4.3 | §1.2, §5 |
| **선행구현 부재 (신규 발상)** | HANNES (`reports/harnesses/hannes.md` §3.1) | §9 — count 기반 escalation만 있던 자리를 두 게이트 교집합으로 대체 |

## 9. 구현 참조 — Convergence는 HANNES 선행구현이 없는 유일한 신규 계약

> 본 계약은 DITTO 11개 계약(§6.1~6.11) 중 **HANNES에 선행 구현이 없는 유일한 신규 계약**이다([`hannes.md`](../../harnesses/hannes.md) §3.1: "DITTO의 유일한 진짜 신규", "설계서의 가장 독창적 기여"). 나머지 10개는 HANNES에서 이미 동작한 사실이 일종의 사전 evidence지만, Convergence는 그렇지 않으므로 **설계 검증 우선순위가 최상위**다([`hannes.md`](../../harnesses/hannes.md) §"다음 단계").

HANNES의 반복 종료는 `state.json.autopilot.{fix_attempts, redesign_attempts}` **카운트 기반 escalation**뿐이었다([`hannes.md`](../../harnesses/hannes.md) §3.1·표). 카운트는 *완료 게이트* 단독과 마찬가지로 한 방향만 막는다 — HANNES의 `PARTIAL_PASS`가 임의 축소를 완료로 위장한 P-9 사건은 완료 게이트만으로는 못 막혔다([`hannes.md`](../../harnesses/hannes.md) §3.1). DITTO는 그 쌍대인 *수렴 게이트*를 추가해 양방향(조기 멈춤 ↔ treadmill)으로 막는다.

| 본 계약 요소 | 선행 상태 / 레퍼런스 | 근거 |
|---|---|---|
| §2 두 게이트 교집합 | **HANNES 미존재** (카운트 escalation만). ouroboros backend∧ledger가 가장 가까운 동형 구현 | [`hannes.md`](../../harnesses/hannes.md) §3.1; [`ouroboros.md`](../../harnesses/ouroboros.md) §2 (`interview_driver.py:204-227`) |
| §3 admissibility (criterion-linked 묵살 불가) | **HANNES 미존재** (신규 발상) | [`hannes.md`](../../harnesses/hannes.md) §3.1 |
| §4 ratchet / decision ledger | **HANNES 미존재.** ouroboros 롤백 invariant가 부분 동형 | [`hannes.md`](../../harnesses/hannes.md) §3.1; [`ouroboros.md`](../../harnesses/ouroboros.md) §2 (`interview_driver.py:805-833`) |
| §5 cap≠converged | ouroboros closure 분기와 동형; HANNES cap은 escalation 트리거였을 뿐 | [`ouroboros.md`](../../harnesses/ouroboros.md) §2 (`interview_driver.py:339-555`, `state.py:378-379`) |
| §4.3 코드 바닥으로 자기보고 누름 | ouroboros `deterministic_floor` | [`ouroboros.md`](../../harnesses/ouroboros.md) §1 (`grading.py:401-425`, `pipeline.py:642-651`) |

구현 위치(메인 §12 Milestone 3): Convergence gate runtime — admissibility 판정, 최선본 보존, decision ledger(`convergence.json`)는 M3에서 채워진다(메인 §12 M3 목표·완료기준: "반복 정련이 두 게이트로 종료되고, 캡 도달은 non-pass로 닫힌다"). DITTO 적용 시 주의(메인 §11 원칙 10, [`hannes.md`](../../harnesses/hannes.md) §5.1 (B)형 누출): admissibility *판정*은 LLM(프롬프트), 그러나 그 *결과*는 schema 제약(`convergence.json` refine)에 묶어 결정론으로 기록한다(메인 §13 Stop hook 표: "convergence admissibility 판정은 LLM, 단 결과를 schema 제약에 묶어 기록"). 판단을 hook 키워드·임계치로 동결하지 않는다.
